// macOS notarization — no-op on other platforms
exports.default = async function notarizing(context) {
  if (process.platform !== "darwin") {
    console.log("[notarize] Skipping — not macOS");
    return;
  }

  const { notarize } = require("@electron/notarize");
  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;

  if (!process.env.APPLE_ID || !process.env.APPLE_ID_PASSWORD) {
    console.log("[notarize] Skipping — APPLE_ID or APPLE_ID_PASSWORD not set");
    return;
  }

  console.log("[notarize] Notarizing…");
  await notarize({
    appPath: `${appOutDir}/${appName}.app`,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_ID_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
};
