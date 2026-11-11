# PowerShell script to generate Code Signing Certificate for Ariso Retail POS

$certDir = "$PSScriptRoot"
$pfxPath = "$certDir\ArisoRetail.pfx"
$cerPath = "$certDir\ArisoRetail.cer"
$pfxPassword = ConvertTo-SecureString -String "ArisoRetail2026!" -Force -AsPlainText

Write-Host "Creating Self-Signed Code Signing Certificate for Ariso Retail POS..." -ForegroundColor Cyan

$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=Ariso Retail POS, O=Ariso Retail, OU=POS Development" `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddYears(5)

Write-Host "Exporting PFX certificate to $pfxPath..." -ForegroundColor Cyan
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pfxPassword -CryptoAlgorithmOption TripleDES_SHA1 -Force | Out-Null

Write-Host "Exporting public CER certificate to $cerPath..." -ForegroundColor Cyan
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

Write-Host "Trusting certificate in Current User Trusted Root & Trusted Publishers..." -ForegroundColor Cyan
Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\CurrentUser\TrustedPublisher" | Out-Null

Write-Host "Certificate generation and installation complete!" -ForegroundColor Green
Write-Host "Thumbprint: $($cert.Thumbprint)" -ForegroundColor Yellow
