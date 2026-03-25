// Post-build artifact fixups — no-op on non-macOS
exports.default = async function fixArtifacts(context) {
  if (process.platform !== "darwin") {
    console.log("[fix-artifacts] Skipping — not macOS");
    return [];
  }

  // macOS-specific artifact fixups can go here
  return [];
};
