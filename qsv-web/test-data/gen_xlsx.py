#!/usr/bin/env python3
"""生成 qsv-web 测试用工作簿（xlsx / ods）。运行: python3 gen_xlsx.py"""
from openpyxl import Workbook
from pathlib import Path

d = Path(__file__).resolve().parent

# ---- P03 导入: 多工作表（可见 x2 + 隐藏 x1）----
wb = Workbook()
ws = wb.active
ws.title = "销售明细"
ws.append(["订单号", "产品", "数量", "金额"])
rows = [
    ("D-001", "苹果", 4, 25.50),
    ("D-002", "香蕉", 10, 40.00),
    ("D-003", "橙子", 6, 33.00),
    ("D-004", "葡萄", 2, 52.00),
]
for r in rows:
    ws.append(r)
ws2 = wb.create_sheet("客户名单")
ws2.append(["客户ID", "客户名称", "城市"])
for i, (cid, name, city) in enumerate([
    ("C-001", "张伟", "上海"),
    ("C-002", "王芳", "北京"),
], start=1):
    ws2.append([cid, name, city])
ws3 = wb.create_sheet("历史备份")
ws3.append(["列一", "列二"])
ws3.append(["旧数据", "1"])
ws3.sheet_state = "hidden"
wb.save(d / "P03_导入_多表工作簿.xlsx")
print("P03_导入_多表工作簿.xlsx OK")

# ---- P08 拆分: 工作表拆分数据（两表，用于“工作表拆分”入口）----
wb2 = Workbook()
s1 = wb2.active
s1.title = "华东"
s1.append(["门店", "品类", "数量"])
for r in [("门店A", "饮料", 100), ("门店A", "零食", 200), ("门店B", "饮料", 50)]:
    s1.append(r)
s2 = wb2.create_sheet("华南")
s2.append(["门店", "品类", "数量"])
for r in [("门店C", "饮料", 80), ("门店D", "零食", 120), ("门店C", "日用品", 10)]:
    s2.append(r)
wb2.save(d / "P08_拆分_工作簿两表.xlsx")
print("P08_拆分_工作簿两表.xlsx OK")

# ---- P08 拆分: 分隔一列 ----
wb3 = Workbook()
h1 = wb3.active
h1.title = "拆分样本"
h1.append(["组合ID", "成分A", "成分B"])
for r in [("G-001", "半份A1", "半份A2"), ("G-002", "半份B1", "半份B2"), ("G-003", "半份C1", "半份C2")]:
    h1.append(r)
wb3.save(d / "P08_拆分_分割字段.xlsx")
print("P08_拆分_分割字段.xlsx OK")

print("xlsx 全部生成")
