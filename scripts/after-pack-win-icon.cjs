const { execFile } = require("node:child_process");
const { access } = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");
const { getRceditBundle } = require("app-builder-lib/out/toolsets/windows");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

const execFileAsync = promisify(execFile);

const addVersionString = (args, key, value) => {
  if (typeof value === "string" && value.trim()) {
    args.push("--set-version-string", key, value);
  }
};

module.exports = async function afterPackWinIcon(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const appInfo = context.packager.appInfo;
  const productFilename = appInfo.productFilename || appInfo.productName;
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const iconPath = path.join(context.packager.projectDir, "assets", "icon.ico");

  await access(exePath);
  await flipFuses(exePath, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true
  });

  if (process.env.SPIDER_BOT_PATCH_WIN_ICON !== "true") {
    return;
  }

  await access(iconPath);

  const version = appInfo.shortVersion || appInfo.buildVersion || appInfo.version;
  const productVersion =
    appInfo.shortVersionWindows ||
    (typeof appInfo.getVersionInWeirdWindowsForm === "function"
      ? appInfo.getVersionInWeirdWindowsForm()
      : version);

  const args = [exePath, "--set-icon", iconPath];
  addVersionString(args, "FileDescription", appInfo.productName);
  addVersionString(args, "ProductName", appInfo.productName);
  addVersionString(args, "LegalCopyright", appInfo.copyright);
  addVersionString(args, "InternalName", productFilename);
  args.push("--set-version-string", "OriginalFilename", "");

  if (version) {
    args.push("--set-file-version", version);
  }
  if (productVersion) {
    args.push("--set-product-version", productVersion);
  }

  const rceditBundle = await getRceditBundle("1.1.0");
  await execFileAsync(rceditBundle.x64, args, {
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
};
