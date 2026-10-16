package credential

// ReadDesktopWorkspaces reads a bounded private snapshot. Tokens stay inside
// the native helper; no persistent decrypted credential store is written.
func ReadDesktopWorkspaces(directory string) ([]Workspace, error) {
	return extractTokens(directory)
}
