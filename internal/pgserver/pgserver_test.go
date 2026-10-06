package pgserver

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUnitText(t *testing.T) {
	unit := Server{Dir: "/home/u/ai/ai-console/postgres"}.UnitText("/usr/bin/docker", 1000, 1000)
	for _, want := range []string{
		"--network none",                  // no TCP reachable from anywhere
		"-c listen_addresses= ",           // and none inside the container either
		"-c unix_socket_permissions=0700", // the socket is the only door
		"--user 1000:1000",                // files belong to the console's user
		"-v /home/u/ai/ai-console/postgres/run:/var/run/postgresql",
		"ExecStartPre=-/usr/bin/docker rm -f tenkstack-postgres",
		Image,
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit lacks %q:\n%s", want, unit)
		}
	}
}

func TestUnitTextQuotesSpaces(t *testing.T) {
	unit := Server{Dir: "/home/u/my ai/postgres"}.UnitText("/usr/bin/docker", 1000, 1000)
	if !strings.Contains(unit, `"/home/u/my ai/postgres/data:/var/lib/postgresql"`) {
		t.Errorf("a path with a space must be quoted:\n%s", unit)
	}
}

func TestDSN(t *testing.T) {
	got := Server{Dir: "/s/postgres"}.DSN()
	if got != "host=/s/postgres/run user=tenkstack dbname=tenkstack sslmode=disable" {
		t.Errorf("DSN = %q", got)
	}
}

// The installer pre-pulls the image, the test script and CI run the same
// major version; a version bump has to reach all of them.
func TestImageIsTheSameEverywhere(t *testing.T) {
	short := strings.TrimPrefix(Image, "docker.io/library/")
	for file, want := range map[string]string{
		"../../install.sh":               Image,
		"../../scripts/lib-pg.sh":        Image,
		"../../.github/workflows/ci.yml": "image: " + short,
	} {
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(b), want) {
			t.Errorf("%s does not use %s", file, want)
		}
	}
}

func TestEnsureLeavesAnotherConsolesUnitAlone(t *testing.T) {
	config := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", config)
	path, _ := UnitPath()
	os.MkdirAll(filepath.Dir(path), 0o755)
	theirs := Server{Dir: "/home/u/ai/ai-console/postgres"}.UnitText("/usr/bin/docker", 1000, 1000)
	os.WriteFile(path, []byte(theirs), 0o644)

	err := Server{Dir: filepath.Join(t.TempDir(), "postgres")}.Ensure(context.Background())
	if err == nil || !strings.Contains(err.Error(), "another console's database") {
		t.Fatalf("Ensure = %v; want a refusal", err)
	}
	if b, _ := os.ReadFile(path); string(b) != theirs {
		t.Error("the other console's unit was rewritten")
	}
}
