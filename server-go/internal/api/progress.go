package api

// Progress receives what a long pull reports: layers, since a
// non-interactive docker pull carries no byte counts.
type Progress interface {
	Layer(done, total int)
	Message(text string)
	Failed(text string)
}
