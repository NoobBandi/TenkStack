package api

type FSRoot struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Note     string `json:"note"`
	Path     string `json:"path"`
	Exists   bool   `json:"exists"`
	Writable bool   `json:"writable"`
	Group    string `json:"group"`
}

type FSRoots struct {
	Roots []FSRoot `json:"roots"`
}

// FSListing is one location: what is in it, whether it takes writes, and
// the space left. Entries are maps because a stat failure lists a shorter
// shape.
type FSListing struct {
	Entries []map[string]any `json:"entries"`
	// Never omitted: the page reads it for every folder, and an empty one
	// is exactly where a missing field would turn into a crash.
	Total        int   `json:"total"`
	Truncated    *bool `json:"truncated,omitempty"`
	Writable     bool  `json:"writable"`
	Free         int64 `json:"free"`
	ReadonlyRoot *bool `json:"readonly_root,omitempty"`
}

type FSLocate struct {
	Root string `json:"root"`
	Path string `json:"path"`
	Name string `json:"name"`
}

type FSTreeSize struct {
	Files int   `json:"files"`
	Bytes int64 `json:"bytes"`
}

type FSNamed struct {
	OK   bool   `json:"ok"`
	Name string `json:"name"`
}

type FSFreed struct {
	OK    bool  `json:"ok"`
	Freed int64 `json:"freed"`
}

type FSOffset struct {
	Offset int64 `json:"offset"`
	Exists bool  `json:"exists"`
	Size   int64 `json:"size,omitempty"`
}

type FSText struct {
	Text     string  `json:"text"`
	Size     int64   `json:"size"`
	Mtime    float64 `json:"mtime"`
	Language string  `json:"language"`
	Writable bool    `json:"writable"`
}

type FSWritten struct {
	OK    bool    `json:"ok"`
	Size  int     `json:"size"`
	Mtime float64 `json:"mtime"`
}
