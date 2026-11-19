@echo off
setlocal DisableDelayedExpansion
for %%I in ("%~dp0..") do set "BROWSERPAW_HOME=%%~fI"
set /p "NODE_EXEC="<"%~dp0node_path.txt"
if not defined NODE_EXEC exit /b 1
"%NODE_EXEC%" "%~dp0host.cjs" %*
exit /b %ERRORLEVEL%
