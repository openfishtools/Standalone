$ErrorActionPreference = 'Stop'

$keystorePath = 'D:\GITHUB\OpenFishTools\fishtools-release.jks'
$alias = 'fishtools-release'
$dname = 'CN=Wahyu Septi Aji, O=OpenFishTools, C=ID'
$propsPath = Join-Path $PSScriptRoot '..\src-tauri\gen\android\keystore.properties'

$keytool = if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\keytool.exe'))) {
    Join-Path $env:JAVA_HOME 'bin\keytool.exe'
} else {
    'C:\Program Files\Microsoft\jdk-17.0.21.102-hotspot\bin\keytool.exe'
}

if (-not (Test-Path $keytool)) {
    Write-Error "keytool.exe tidak ditemukan di: $keytool"
    exit 1
}

if (Test-Path $keystorePath) {
    Write-Host "Keystore sudah ada di: $keystorePath" -ForegroundColor Yellow
    Write-Host "Hapus atau pindahkan file lama dulu jika memang ingin membuat ulang." -ForegroundColor Yellow
    exit 1
}

function ConvertFrom-SecureToPlain([Security.SecureString]$sec) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$sec1 = Read-Host -Prompt 'Masukkan password Keystore (minimal 6 karakter)' -AsSecureString
$sec2 = Read-Host -Prompt 'Ulangi password Keystore' -AsSecureString
$pass1 = ConvertFrom-SecureToPlain $sec1
$pass2 = ConvertFrom-SecureToPlain $sec2

if ($pass1.Length -lt 6) {
    Write-Error 'Password minimal 6 karakter.'
    exit 1
}
if ($pass1 -ne $pass2) {
    Write-Error 'Password tidak cocok.'
    exit 1
}

Write-Host "`nMembuat Release Keystore..." -ForegroundColor Cyan
& $keytool -genkeypair -v `
    -keystore $keystorePath `
    -storetype PKCS12 `
    -keyalg RSA `
    -keysize 4096 `
    -validity 10000 `
    -alias $alias `
    -dname $dname `
    -storepass $pass1 `
    -keypass $pass1

if ($LASTEXITCODE -ne 0) {
    Write-Error "keytool gagal dengan exit code $LASTEXITCODE"
    exit 1
}

$escapedPath = $keystorePath.Replace('\', '/')
$propsContent = @"
storeFile=$escapedPath
storePassword=$pass1
keyAlias=$alias
keyPassword=$pass1
"@
[IO.File]::WriteAllText($propsPath, $propsContent, [Text.UTF8Encoding]::new($false))

Write-Host "`nSelesai!" -ForegroundColor Green
Write-Host "  Keystore   : $keystorePath"
Write-Host "  Properties : $propsPath (sudah masuk .gitignore)"
Write-Host "  Alias      : $alias"
Write-Host "`nPENTING: Simpan backup $keystorePath dan password-nya di tempat aman." -ForegroundColor Yellow
Write-Host "Untuk build APK release bertanda tangan sekarang, jalankan: npm run build:android"
