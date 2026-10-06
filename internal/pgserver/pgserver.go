// Package pgserver runs the console's own PostgreSQL: a container under a
// systemd user unit, like the other services the console depends on.
//
// The console sets it up itself, on start, rather than leaving it to
// install.sh: an install updates by replacing the console binary (the 關於
// page), so the first start of a version that needs a database has to be
// able to make one.
//
// It has no TCP listener and no network at all. The only way in is the unix
// socket in <state>/postgres/run, a 0700 directory of the console's user, so
// being able to connect means being that user -- the same boundary the
// SQLite file had -- and there is no password to keep anywhere.
package pgserver

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const (
	Unit      = "tenkstack-postgres.service"
	Container = "tenkstack-postgres"
	// The major version is the data directory's format: moving to 19 is a
	// dump and restore, not an image change, so it is pinned here on purpose.
	Image    = "docker.io/library/postgres:18-alpine"
	User     = "tenkstack"
	Database = "tenkstack"
)

// Server is one database's files: data/ (the cluster) and run/ (the socket).
type Server struct {
	Dir string
}

func (s Server) dataDir() string { return filepath.Join(s.Dir, "data") }
func (s Server) runDir() string  { return filepath.Join(s.Dir, "run") }

// DSN reaches the server through its socket directory.
func (s Server) DSN() string {
	return fmt.Sprintf("host=%s user=%s dbname=%s sslmode=disable", s.runDir(), User, Database)
}

// UnitText is the unit Ensure writes. The container runs as the console's
// user, so the files it creates belong to that user and backups can read
// them. trust is safe only because of the other two settings: no TCP
// listener, and a socket nobody else can reach.
func (s Server) UnitText(docker string, uid, gid int) string {
	args := []string{
		docker, "run", "--rm", "--name", Container,
		"--network", "none",
		"--user", fmt.Sprintf("%d:%d", uid, gid),
		"-v", s.dataDir() + ":/var/lib/postgresql",
		"-v", s.runDir() + ":/var/run/postgresql",
		"-e", "POSTGRES_USER=" + User,
		"-e", "POSTGRES_DB=" + Database,
		"-e", "POSTGRES_HOST_AUTH_METHOD=trust",
		Image,
		"-c", "listen_addresses=",
		"-c", "unix_socket_permissions=0700",
	}
	for i, a := range args {
		args[i] = quote(a)
	}
	run := strings.Join(args, " ")
	return fmt.Sprintf(`# Written by the TenkStack console, which rewrites it when it differs.
[Unit]
Description=PostgreSQL for the TenkStack console (unix socket only)

[Service]
Type=simple
# A container left behind by an unclean stop would make the next run fail on
# the name; removing it first is what makes Restart= actually restart.
ExecStartPre=-%[1]s rm -f %[2]s
ExecStart=%[3]s
ExecStop=%[1]s stop -t 60 %[2]s
Restart=on-failure
RestartSec=5
TimeoutStopSec=90

[Install]
WantedBy=default.target
`, quote(docker), Container, run)
}

// quote is systemd's command-line quoting, for a state directory with a
// space in its path.
func quote(arg string) string {
	if !strings.ContainsAny(arg, " \t\"'\\") {
		return arg
	}
	return `"` + strings.NewReplacer(`\\`, `\\\\`, `"`, `\\"`).Replace(arg) + `"`
}

// UnitPath is where the user's systemd looks for the unit.
func UnitPath() (string, error) {
	config := os.Getenv("XDG_CONFIG_HOME")
	if config == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		config = filepath.Join(home, ".config")
	}
	return filepath.Join(config, "systemd", "user", Unit), nil
}

// Ensure makes the directories, writes the unit when it is missing or
// differs, and starts it. It does not wait for the server to answer; the
// connection does that (the first start pulls the image).
func (s Server) Ensure(ctx context.Context) error {
	for _, dir := range []string{s.dataDir(), s.runDir()} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		if err := os.Chmod(dir, 0o700); err != nil { // MkdirAll leaves an existing one as it was
			return err
		}
	}
	path, err := UnitPath()
	if err != nil {
		return err
	}
	have, readErr := os.ReadFile(path)
	// One unit name per user: a console started with another state directory
	// (a development copy, a second install) must not take over the first
	// one's database by rewriting its unit.
	if readErr == nil && !bytes.Contains(have, []byte(s.dataDir()+":/var/lib/postgresql")) {
		return fmt.Errorf("%s runs another console's database, not %s; set CONSOLE_DATABASE_URL to use a database of its own", path, s.dataDir())
	}
	docker, err := exec.LookPath("docker")
	if err != nil {
		return errors.New("the console's database runs in Docker, and docker is not on PATH")
	}
	want := s.UnitText(docker, os.Getuid(), os.Getgid())
	if readErr != nil || !bytes.Equal(have, []byte(want)) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, []byte(want), 0o644); err != nil {
			return err
		}
		if err := systemctl(ctx, "daemon-reload"); err != nil {
			return err
		}
		// A unit that changed while running keeps the old command until it
		// restarts; the console is starting, so nothing is using it yet.
		if active(ctx) {
			if err := systemctl(ctx, "restart", Unit); err != nil {
				return err
			}
		}
	}
	return systemctl(ctx, "enable", "--now", Unit)
}

func active(ctx context.Context) bool {
	return exec.CommandContext(ctx, "systemctl", "--user", "is-active", "--quiet", Unit).Run() == nil
}

func systemctl(ctx context.Context, args ...string) error {
	out, err := exec.CommandContext(ctx, "systemctl", append([]string{"--user"}, args...)...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl --user %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Backup writes a dump of the database to path (pg_dump's custom format,
// which pg_restore reads), through the running container. To restore:
//
//	docker exec -i tenkstack-postgres pg_restore -U tenkstack -d tenkstack --clean --if-exists < FILE
func Backup(ctx context.Context, path string) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "docker", "exec", Container, "pg_dump", "-U", User, "-Fc", Database)
	cmd.Stdout = f
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	closeErr := f.Close()
	if runErr != nil {
		os.Remove(path)
		return fmt.Errorf("pg_dump: %v: %s", runErr, strings.TrimSpace(stderr.String()))
	}
	return closeErr
}
