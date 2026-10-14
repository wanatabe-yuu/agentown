package main

import (
	"os/exec"
	"strings"
	"testing"
)

func TestShqRoundTrip(t *testing.T) {
	for _, v := range []string{"plain", "it's", `a"b`, "$(id)", "`id`", "a\nb", ""} {
		out, err := exec.Command("sh", "-c", "printf %s "+shq(v)).Output()
		if err != nil || string(out) != v {
			t.Errorf("shq(%q) -> %q (%v)", v, out, err)
		}
	}
}

func TestScriptsAreValidBash(t *testing.T) {
	scripts := map[string]string{
		"facts":    factsScript,
		"latest":   latestTagScript("o/r"),
		"org":      uploadOrgScript("YWJj"),
		"install":  installScript("https://example.com/install.sh", "v0.1.0", "kubernetes", "o/r"),
		"joinInfo": joinInfoScript,
		"join":     joinNodeScript("10.0.0.1", "K10::server:abc'x", "v1.30.6+k3s1", "node-1", "dedicated"),
		"settle":   settleNodeScript("node-1", "shared"),
		"hasImage": hasImageScript("docker.io/agentown/harness:0.1.0"),
		"status":   statusScript,
		"nodes":    nodeNamesScript,
	}
	for name, s := range scripts {
		cmd := exec.Command("bash", "-n")
		cmd.Stdin = strings.NewReader("set -euo pipefail\n" + s)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Errorf("%s: %v\n%s", name, err, out)
		}
	}
}

func TestJoinScriptPools(t *testing.T) {
	ded := joinNodeScript("10.0.0.1", "tok", "v1", "n", "dedicated")
	if !strings.Contains(ded, "POOL='dedicated'") || !strings.Contains(ded, "agentown.io/dedicated=true:NoSchedule") {
		t.Fatal("dedicated node must be tainted")
	}
	if strings.Contains(joinNodeScript("10.0.0.1", "tok", "v1", "n", "shared"), "POOL='dedicated'") {
		t.Fatal("shared node got the dedicated pool")
	}
}

func TestCheckFacts(t *testing.T) {
	ok := map[string]string{"os": "ubuntu", "os_version": "24.04", "arch": "x86_64", "systemd": "yes"}
	if p := checkFacts(ok); len(p) != 0 {
		t.Fatalf("unexpected problems: %v", p)
	}
	bad := map[string]string{"os": "debian", "os_version": "12", "arch": "aarch64", "systemd": "no"}
	if p := checkFacts(bad); len(p) != 3 {
		t.Fatalf("expected 3 problems, got %v", p)
	}
}

func TestParseKV(t *testing.T) {
	m := parseKV("a=1\nb=x=y\n\nnoise\nc=")
	if m["a"] != "1" || m["b"] != "x=y" || m["c"] != "" || len(m) != 3 {
		t.Fatalf("%v", m)
	}
}
