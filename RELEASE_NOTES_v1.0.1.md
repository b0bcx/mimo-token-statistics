## MiMo Token Statistics v1.0.1

在 v1.0.0 基础上的体验与安全增强。

### 新增

- **设置页**：改密码（默认收起，点「修改密码」展开）、退出登录
- **功能偏好**：自动刷新间隔（5/10/15/30/60 秒）、Shift 多选开关、主题跟随系统开关
- 会话详情：入/出/缓存与命中率布局优化；桌面 2×2 四格，窄屏合并展示

### 修复 / 改进

- 手机端每日消耗热力图月份标签与格子对齐（按实际格宽+间距定位）
- 全站移动端适配：顶栏、会话筛选、弹窗、表格等
- 模型 ID 说明更正：Smart 路由 / 常规 flash·pro / 旧版 CLI `mimo-auto`
- 默认仍监听 `0.0.0.0`，访问密码默认 `root`

### 安装

1. 下载 Source code zip 或 `git clone`
2. 需要 Python 3.9+
3. `python server.py` 或双击 `启动统计服务.bat`
4. 打开 http://127.0.0.1:8765 ，默认密码 `root`

### 命令行

```bash
python server.py
python server.py --password 强口令
python server.py --no-auth
python server.py --host 127.0.0.1
```
