## MiMo Token Statistics v1.0.0

本地 **Xiaomi MiMo Desktop** Token 用量统计看板首个正式版：纯 Python 标准库 + 静态前端，零第三方依赖。

### Highlights

- 每日贡献热力图、24h 分模型堆叠、模型 / 项目 / 会话排行、洞察卡片、CSV 导出
- Shift 多选日期 / 小时联动重算
- **默认监听 `0.0.0.0`**，方便局域网与内网穿透访问
- **访问密码**（默认 `root`）：未登录跳转 `/login`，API 返回 401
- 只读解析本机 `mimocode.db`，不上传数据

### 安装

1. 下载 Source code zip 并解压，或 `git clone`
2. 需要 Python 3.9+
3. 运行 `python server.py` 或双击 `启动统计服务.bat`
4. 打开 http://127.0.0.1:8765 ，输入密码（默认 `root`）

### 命令行

```bash
python server.py
python server.py --port 8765 --host 127.0.0.1 --password 强口令
python server.py --no-auth
python server.py --db "/path/to/mimocode.db"
```

### 安全提示

- 对外暴露前请修改默认密码
- 建议配合 HTTPS 反代 / 防火墙使用
