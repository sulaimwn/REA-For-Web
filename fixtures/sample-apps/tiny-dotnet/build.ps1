# Builds TinyNotes.exe with the .NET Framework 4 C# compiler that ships with Windows.
# The committed TinyNotes.exe is the one the fixtures were generated from: this compiler is
# not deterministic (new MVID per build), so rebuilding means regenerating the fixtures.
# The program is only ever read by REA; it is never run.
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
& "$fw\csc.exe" /nologo /target:exe /platform:anycpu /optimize+ /out:"$PSScriptRoot\TinyNotes.exe" `
  /r:"$fw\System.Net.Http.dll" /resource:"$PSScriptRoot\strings.txt",TinyNotes.Strings.txt "$PSScriptRoot\TinyNotes.cs"
if ($LASTEXITCODE) { throw 'csc failed' }
Get-Item "$PSScriptRoot\TinyNotes.exe" | Select-Object Name, Length
