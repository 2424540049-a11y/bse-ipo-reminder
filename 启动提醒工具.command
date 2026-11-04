#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if command -v python3 >/dev/null 2>&1; then
  python3 app.py
else
  echo "需要 Python 3.9 或更新版本。安装后重新双击此文件。"
fi
if [[ $? -ne 0 ]]; then
  echo "启动失败，请查看上方提示。按回车关闭。"
  read
fi
