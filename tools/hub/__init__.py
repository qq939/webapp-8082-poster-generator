# -*- coding: utf-8 -*-
"""Hermit Tools Hub 源码包（tools/hub）。

- registry: 工具注册表（纯标准库，文件级持久化；容器内为 /config/tools_registry.json，
  宿主机为 config/registry/tools_registry.json —— control 面板与 Hub 卡片共用这一份，
  由 control 建卡片时把 config/registry 挂到卡片的 /config，详见 control/app.py 的 _registry_volume）
- app: Hub Flask app（create_tools_hub_app），提供对接文档首页 + /api/tools 接口

注意：__init__.py 仅导出纯标准库的 registry，避免 import 时引入 flask 依赖。
Flask Hub app 由 control/app.py 通过 `from tools.hub.app import create_tools_hub_app` 显式导入。
"""
from . import registry  # noqa: F401
