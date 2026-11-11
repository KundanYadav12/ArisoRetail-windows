@echo off
:: Batch script to install Ariso Retail POS certificate on any client/terminal PC
echo Installing Ariso Retail POS Certificate to Trusted Root & Trusted Publishers...
certutil -addstore -f "Root" "%~dp0ArisoRetail.cer"
certutil -addstore -f "TrustedPublisher" "%~dp0ArisoRetail.cer"
echo.
echo Certificate installation complete. Ariso Retail POS will now run without security blocks.
pause
