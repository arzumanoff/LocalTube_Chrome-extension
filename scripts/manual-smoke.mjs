console.log(`
Manual smoke test — run once after code changes affecting the native flow

Prerequisites:
1. Build and install native-host (see native-host/README.md).
2. Reload the unpacked extension in chrome://extensions.
3. Refresh the YouTube tab.

Scenarios:
A. Open a low-resolution video. Confirm the dialog shows only real qualities; no fake 1080p/4K.
B. Open a real 1080p video. Select 1080p and confirm the saved MP4 has sound and 1080p resolution.
C. Open a real 4K video. Select 2160p and confirm the output remains 2160p.
D. Edit the suggested filename and confirm Windows Save As receives that name.
E. Cancel Save As and confirm no download starts.
F. Start a download, press Cancel, and confirm the host stops it.

Do not repeat these downloads without a code change that affects the tested scenario.
`);
