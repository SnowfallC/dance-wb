@echo off
REM 舞刀 一键启动（Windows）
cd /d "%~dp0"
echo 正在启动 舞刀 工作台……
python serve.py 8000
pause
