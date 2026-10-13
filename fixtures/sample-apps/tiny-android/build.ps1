# Builds tiny-notes.apk without Gradle: javac -> d8 -> aapt2 link -> add dex -> zipalign -> apksigner.
# Needs the Android SDK (build-tools 36.1.0, platform android-36.1) and Android Studio's bundled JDK.
# The APK is only ever read by REA; it is never installed or run.
# Native tools print progress on stderr; check exit codes instead of stopping on stderr.
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$bt = "$sdk\build-tools\36.1.0"
$jar = "$sdk\platforms\android-36.1\android.jar"
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$jdk = "$env:JAVA_HOME\bin"
$env:PATH = "$jdk;$env:PATH"
$out = Join-Path $here 'out'
Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$out\classes", "$out\dex" | Out-Null

$sources = Get-ChildItem -Recurse "$here\src" -Filter *.java | ForEach-Object FullName
& "$jdk\javac.exe" --release 11 -classpath $jar -d "$out\classes" @sources
if ($LASTEXITCODE) { throw 'javac failed' }

$classes = Get-ChildItem -Recurse "$out\classes" -Filter *.class | ForEach-Object FullName
& "$bt\d8.bat" --release --min-api 24 --lib $jar --output "$out\dex" @classes
if ($LASTEXITCODE) { throw 'd8 failed' }

& "$bt\aapt2.exe" link -o "$out\base.apk" -I $jar --manifest "$here\AndroidManifest.xml" -A "$here\assets" --min-sdk-version 24 --target-sdk-version 34
if ($LASTEXITCODE) { throw 'aapt2 link failed' }

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$out\base.apk", 'Update')
try {
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$out\dex\classes.dex", 'classes.dex') | Out-Null
} finally { $zip.Dispose() }

& "$bt\zipalign.exe" -f -p 4 "$out\base.apk" "$out\aligned.apk"
if ($LASTEXITCODE) { throw 'zipalign failed' }

$ks = "$out\debug.keystore"
& "$jdk\keytool.exe" -genkeypair -keystore $ks -storepass android -keypass android -alias sample -keyalg RSA -keysize 2048 -validity 3650 -dname 'CN=REA for Web sample, O=Fixtures' 2>$null
if ($LASTEXITCODE) { throw 'keytool failed' }
& "$bt\apksigner.bat" sign --ks $ks --ks-pass pass:android --key-pass pass:android --out "$here\tiny-notes.apk" "$out\aligned.apk"
if ($LASTEXITCODE) { throw 'apksigner failed' }
# The throwaway signing key and intermediates are not kept.
Remove-Item -Recurse -Force $out
Get-Item "$here\tiny-notes.apk" | Select-Object Name, Length
