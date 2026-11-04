; ============================================================
; 漫客（MANKE-AIGC 本地画布）安装包模板
; 用法：修改 SourceRoot 为打包目录，然后用 Inno Setup 6 编译
;   ISCC.exe installer\manke.iss
; ============================================================

#define SourceRoot "C:\path\to\Manke"
#define AppVersion "2.10.79"
#define OutputDir "."
#define OutputBase "漫客_安装程序_v2.10.79_release"

[Setup]
AppId={{3C9E2F41-7A6B-4D2E-9F10-8B5C4A1D2E63}
AppName=漫客
AppVersion={#AppVersion}
AppVerName=漫客 {#AppVersion}
AppPublisher=漫客
DefaultDirName={sd}\Manke
DefaultGroupName=漫客
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBase}
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\Manke.exe
UsePreviousAppDir=yes
WizardStyle=modern
; 图标：把 manke.ico 放到 installer\ 下并取消下一行注释
; SetupIconFile=installer\manke.ico

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; 程序文件（排除 data 与卸载器）
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "data\*,unins000.dat,unins000.exe"

[Icons]
Name: "{group}\漫客"; Filename: "{app}\Manke.exe"
Name: "{group}\卸载 漫客"; Filename: "{uninstallexe}"
Name: "{autodesktop}\漫客"; Filename: "{app}\Manke.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Manke.exe"; Description: "{cm:LaunchProgram,漫客}"; Flags: nowait postinstall skipifsilent
