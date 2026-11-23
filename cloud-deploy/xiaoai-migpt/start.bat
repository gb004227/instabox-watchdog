@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal

echo ============================================
echo   小爱音箱控制台  (Xiaomi 智能音箱 Pro / OH2P)
echo ============================================
echo.

if not exist node_modules (
  echo [1/2] 首次运行，正在安装依赖...
  call npm install --no-audit --no-fund
  echo.
)

if not exist public\index.html (
  echo [错误] 找不到 public\index.html，界面文件缺失
  pause
  exit /b 1
)

set PORT=3000
echo [2/2] 启动服务...
echo   浏览器会自动打开 http://127.0.0.1:%PORT%
echo   关闭这个窗口即停止服务
echo.

start "" cmd /c "timeout /t 3 >nul && start http://127.0.0.1:%PORT%"

node server.mjs

echo.
echo 服务已退出。
pause
