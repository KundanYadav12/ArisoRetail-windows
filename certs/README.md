# Ariso Retail POS Code Signing Certificates

This directory contains the code signing certificate assets and utilities for **Ariso Retail POS**.

## Files in this Directory

- `ArisoRetail.pfx`: The private code-signing certificate used by `electron-builder` to sign all desktop executables and installers.
  - **Password**: `ArisoRetail2026!`
  - **Subject**: `CN=Ariso Retail POS, O=Ariso Retail, OU=POS Development`
  - **Validity**: 5 Years
  - **Hash Algorithm**: SHA256

- `ArisoRetail.cer`: The public certificate used to install trust on client PCs and POS terminals.

- `generate-cert.ps1`: Automated PowerShell script to generate and export compatible PKCS#12 certificates.

- `trust-cert-on-terminal.bat`: Double-click installer to add `ArisoRetail.cer` to Windows Trusted Root & Trusted Publishers on any POS machine.

---

## How Code Signing Works in Ariso Retail POS

1. **Automated Build Signing**:
   Running `npm run dist:win` in `frontend/` compiles the React Vite frontend and triggers `electron-builder`.
   `electron-builder` automatically uses `certs/ArisoRetail.pfx` to digitally sign:
   - `dist-electron/win-unpacked/Ariso Retail POS.exe`
   - `dist-electron/Ariso Retail POS Setup 1.0.0.exe` (NSIS installer & uninstaller)

2. **Terminal / Client Machine Trust**:
   To install the certificate on a client/store PC so Windows Smart App Control and SmartScreen recognize it without warnings:
   - Copy `ArisoRetail.cer` and `trust-cert-on-terminal.bat` to the client PC.
   - Right-click `trust-cert-on-terminal.bat` and select **Run as administrator**.

3. **Production Distribution with Commercial Certificates (DigiCert / EV / Azure Trusted Signing)**:
   When moving to public distribution across untrusted third-party devices:
   - Set environment variables `$env:CSC_LINK` and `$env:CSC_KEY_PASSWORD` with your commercial PFX certificate, or configure Azure Trusted Signing.
   - `electron-builder` will sign with the commercial CA certificate automatically.
