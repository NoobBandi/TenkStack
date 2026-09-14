// Package webdist carries the built frontend inside the binary, so an
// install is one file. build.sh copies web/dist here before go build; a
// checkout without it embeds only the placeholder, and the server then
// serves whatever CONSOLE_WEB_DIST points at.
package webdist

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var files embed.FS

// FS is the built frontend, or nil when only the placeholder is embedded.
func FS() fs.FS {
	sub, err := fs.Sub(files, "dist")
	if err != nil {
		return nil
	}
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil
	}
	return sub
}
