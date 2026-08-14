@echo off
setlocal

echo 正在安装必要的 Python 包...
pip install pyinstaller psutil

echo 正在构建 WebSocket 服务器可执行文件...
pyinstaller --noconsole --onefile --name ws_server_pure ws_server_pure.py

echo 构建完成！可执行文件位置: dist\ws_server.exe

endlocal
pause
