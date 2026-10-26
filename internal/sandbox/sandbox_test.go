package sandbox

import (
	"slices"
	"strings"
	"testing"
)

func TestValidSession(t *testing.T) {
	for _, s := range []string{"chat-12", "k3x9a0b", strings.Repeat("a", 64)} {
		if !ValidSession(s) {
			t.Errorf("%q should be valid", s)
		}
	}
	for _, s := range []string{"", "a b", "../x", "a;rm", strings.Repeat("a", 65), "chat_1"} {
		if ValidSession(s) {
			t.Errorf("%q should be refused", s)
		}
	}
}

// One person's session id must not name another's container.
func TestContainerNameIsPerOwner(t *testing.T) {
	a, b := containerName(1, "chat-5"), containerName(2, "chat-5")
	if a == b {
		t.Fatalf("same name for two owners: %s", a)
	}
	if !strings.HasPrefix(a, namePrefix) || strings.Contains(a, "chat-5") {
		t.Fatalf("name %q should be prefixed and hashed", a)
	}
}

func TestCleanPath(t *testing.T) {
	cases := map[string]string{
		"out.csv":       "out.csv",
		"a/b/../c.txt":  "a/c.txt",
		"./x.png":       "x.png",
		"../etc/passwd": "",
		"/etc/passwd":   "",
		"a/../../x":     "",
		"..":            "",
		".":             "",
		"":              "",
		"a\x00b":        "",
	}
	for in, want := range cases {
		if got := CleanPath(in); got != want {
			t.Errorf("CleanPath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestClipCountsCharacters(t *testing.T) {
	text := strings.Repeat("中", 10)
	if got, cut := Clip(text, 10); cut || got != text {
		t.Fatalf("10 characters should fit in 10: %q %v", got, cut)
	}
	got, cut := Clip(text, 4)
	if !cut || !strings.HasPrefix(got, "中中中中\n") {
		t.Fatalf("clip should cut on characters: %q", got)
	}
}

// The isolation is the arguments. Each of these is a property the safety
// argument rests on, so losing one should fail loudly.
func TestRunArgsIsolate(t *testing.T) {
	args := RunArgs("tenkstack-sandbox-u1-abc", Repo+":x", 1, "chat-1", 4)
	for _, want := range []string{
		"--runtime=runsc", "--network=none", "--read-only", "--cap-drop=ALL",
		"--security-opt=no-new-privileges", "--user=1000:1000", "--memory=4g", "--memory-swap=4g",
	} {
		if !slices.Contains(args, want) {
			t.Errorf("missing %s in %v", want, args)
		}
	}
	for _, a := range args {
		if a == "-v" || a == "--volume" || a == "--mount" || a == "--privileged" || strings.HasPrefix(a, "--device") {
			t.Errorf("must not mount or grant devices: %v", args)
		}
	}
	if args[len(args)-1] != Repo+":x" {
		t.Errorf("image must be last, with no command after it: %v", args)
	}
}

func TestTagFollowsRecipe(t *testing.T) {
	tag := Tag()
	if !strings.HasPrefix(tag, Repo+":") || len(tag) != len(Repo)+1+12 {
		t.Fatalf("unexpected tag %q", tag)
	}
	if Tag() != tag {
		t.Fatal("tag must be stable")
	}
}
