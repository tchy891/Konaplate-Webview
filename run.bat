@echo off
rem Launch the KONA WebView Helper (web UI) and open it in the browser
cd /d "%~dp0"
python -X utf8 server.py --port 8770
if errorlevel 1 pause
