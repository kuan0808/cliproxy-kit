package main

import (
	"embed"
	"net/http"
)

// The plugin's page in the management panel: the routing ledger and the usage report. It is
// built from ui/ into page/index.html by scripts/install-plugin.sh and embedded here; a build
// without it still loads, and the page then says how to build it.
//
//go:embed all:page
var pageFiles embed.FS

// The panel lists a resource with a menu label in its sidebar and shows it in a frame. It shows
// plugin fields as written, in whatever language it is in, so the label is the plugin's name, the
// same in every language; the page's own title follows the panel's language. The description
// shows only beside the collapsed sidebar.
var pageResource = map[string]string{
	"Path":        "/ui",
	"Menu":        "quota-pilot",
	"Description": "用量帳本 · Usage ledger",
}

// pageResponse serves the page. Resource routes are not authenticated, so the page carries no
// data: it reads everything through the management routes with the panel's key. Only the panel's
// own origin may frame it.
func pageResponse() ([]byte, error) {
	body, errRead := pageFiles.ReadFile("page/index.html")
	if errRead != nil {
		return okEnvelope(map[string]any{
			"StatusCode": http.StatusServiceUnavailable,
			"Headers":    http.Header{"Content-Type": {"text/plain; charset=utf-8"}, "Cache-Control": {"no-store"}},
			"Body":       []byte("quota-pilot was built without its page; run scripts/install-plugin.sh\n"),
		})
	}
	return okEnvelope(map[string]any{
		"StatusCode": http.StatusOK,
		"Headers": http.Header{
			"Content-Type":            {"text/html; charset=utf-8"},
			"Cache-Control":           {"no-store"},
			"Content-Security-Policy": {"frame-ancestors 'self'"},
			"X-Content-Type-Options":  {"nosniff"},
		},
		"Body": body,
	})
}
