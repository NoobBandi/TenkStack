package api

// Progress receives what a long pull reports: layers, and bytes of the
// layers being downloaded when the Engine API is there to count them.
type Progress interface {
	Layer(done, total int)
	Bytes(done, total int64)
	Message(text string)
	Failed(text string)
}
