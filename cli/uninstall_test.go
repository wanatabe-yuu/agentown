package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestUninstallScriptInSync(t *testing.T) {
	original, err := os.ReadFile("../deploy/uninstall.sh")
	if err != nil {
		t.Fatal(err)
	}
	if string(original) != uninstallScript {
		t.Fatal("cli/uninstall.sh differs from deploy/uninstall.sh: run `cp deploy/uninstall.sh cli/uninstall.sh`")
	}
}

func TestUninstallScriptIsValidBash(t *testing.T) {
	cmd := exec.Command("bash", "-n")
	cmd.Stdin = strings.NewReader("set -- --yes --all\n" + uninstallScript)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
