; ── Media Downloader — Inno Setup installer ────────────────────────
; Compiled in CI: ISCC /DAppVersion=X.Y.Z /DSourcePath="C:\repo" /O"out" setup.iss

#define AppName     "Media Downloader"
#define AppPublisher "Arzumanoff"
#define AppURL       "https://github.com/arzumanoff/youtube-downloader-chrome-extension"
#define EngineDir   "{localappdata}\ArzumanoffMediaEngine"
#define ExtDir      "{localappdata}\MediaDownloader\extension"
#define HostName    "com.arzumanoff.media_engine"
#define ExtId       "cahgieplmdniiggmdiledlbjdbclbhjd"

[Setup]
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
DefaultDirName={#EngineDir}
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputBaseFilename=MediaDownloader-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
Uninstallable=yes
LicenseFile={#SourcePath}\LICENSE
InfoAfterFile={#SourcePath}\scripts\postinstall-ru.txt

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; ── Engine ─────────────────────────────────────────────────────────
Source: "{#SourcePath}\native-host\dist\media-engine-host.exe"; DestDir: "{app}"; Flags: ignoreversion

; ── Runtime tools ──────────────────────────────────────────────────
Source: "{#SourcePath}\native-host\tools\ffmpeg.exe";  DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourcePath}\native-host\tools\ffprobe.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourcePath}\native-host\tools\deno.exe";    DestDir: "{app}"; Flags: ignoreversion

; ── Chrome extension (unpacked) ────────────────────────────────────
Source: "{#SourcePath}\release\extension\*"; DestDir: "{#ExtDir}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Run]
; ── Hardware detection ─────────────────────────────────────────────
Filename: "{app}\media-engine-host.exe"; Parameters: "--detect-hardware"; \
  StatusMsg: "Определение видеоэнкодера..."; \
  Flags: runhidden waituntilterminated; \
  Check: not CmdLineParam('/NOHW')

; ── Open chrome://extensions ───────────────────────────────────────
Filename: "chrome.exe"; Parameters: "chrome://extensions"; \
  Description: "Открыть страницу расширений Chrome"; \
  Flags: nowait postinstall shellexec skipifsilent unchecked

[Registry]
; ── Native Messaging host registration ─────────────────────────────
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\{#HostName}"; \
  ValueType: string; ValueData: "{app}\native-host.json"; \
  Flags: uninsdeletekey

[UninstallRun]
; ── Cleanup registry ───────────────────────────────────────────────
Filename: "reg"; Parameters: "delete HKCU\Software\Google\Chrome\NativeMessagingHosts\{#HostName} /f"; \
  Flags: runhidden; RunOnceId: "DeleteReg"

[Code]
function CmdLineParam(const Name: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), Name) = 0 then
    begin
      Result := True;
      Exit;
    end;
end;

{ Write native-host.json manifest after install }
procedure CurStepChanged(CurStep: TSetupStep);
var
  ManifestPath: String;
  ManifestJSON: String;
  InstallDir: String;
begin
  if CurStep = ssPostInstall then
  begin
    InstallDir := ExpandConstant('{app}');
    ManifestPath := InstallDir + '\native-host.json';
    ManifestJSON :=
      '{' + #13#10 +
      '  "name": "' + '{#HostName}' + '",' + #13#10 +
      '  "description": "Local media download engine",' + #13#10 +
      '  "path": "' + InstallDir + '\media-engine-host.exe",' + #13#10 +
      '  "type": "stdio",' + #13#10 +
      '  "allowed_origins": ["chrome-extension://' + '{#ExtId}' + '/"]' + #13#10 +
      '}';
    if not SaveStringToFile(ManifestPath, ManifestJSON, False) then
      SuppressibleMsgBox('Не удалось записать манифест Native Host: ' + ManifestPath, mbError, MB_OK, IDOK);
  end;
end;

{ Remove extension directory on uninstall }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    DelTree(ExpandConstant('{#ExtDir}'), True, True, True);
end;