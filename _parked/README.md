# 已下线模块（归档区）

这些模块只是**暂时下线**，代码完整保留，随时可以放回去。

## 已归档内容

| 文件 | 原属 | 说明 |
| --- | --- | --- |
| `page-features.html` | 首页导航「核心特性」 | 算法特性介绍区块，原 `index.html` 第 137-168 行 |
| `page-guide.html` | 首页导航「参数指南」 | σₛ / σᵣ 参数说明区块，原 `index.html` 第 169-237 行 |
| `page-filter.html` | 首页导航「创意滤镜」 | 胶片模拟滤镜整页，原 `index.html` 第 639-787 行 |
| `page-palette.html` | 首页导航「色卡」 | 调色盘提取整页，原 `index.html` 第 752-801 行 |
| `filter.js` | 创意滤镜逻辑 | 滤镜算法与页面交互 |
| `filter.css` | 创意滤镜样式 | 滤镜页样式 |
| `palette.js` | 色卡逻辑 | 主色调提取与合成图 |
| `palette.css` | 色卡样式 | 色卡页样式 |

## 恢复方法

以「核心特性」为例，其余同理：

1. 打开 `_parked/page-features.html`，去掉文件开头的归档说明注释，复制剩余全部内容
2. 粘回 `index.html` 中其他 `<section class="page-section">` 旁边
3. 补回导航栏项：在 `index.html` 的 `.nav-link` 列表里加一行
   `<span class="nav-link" data-page="features" data-i18n="navFeatures">核心特性</span>`
4. 在 `main.js` 的 `NAV_ORDER` 数组里加回 `'features'`（顺序要和导航栏一致）
5. 创意滤镜额外三步：
   - `index.html` 里恢复 `<link rel="stylesheet" href="filter.css" />` 和 `<script src="filter.js"></script>`（注意路径改为 `_parked/filter.css`、`_parked/filter.js`，或把两个文件挪回根目录）
   - `main.js` 的 `_panelDefs` 加回 `{ id: 'filterPanel', backdropId: 'filterMobileBackdrop', pageId: 'page-filter' }`
   - `archive.js` 恢复 `window.archiveFromFilter`（滤镜页「存入档案库」入口）

## 说明

- 归档目录名以 `_` 开头，GitHub Pages 的 Jekyll 会跳过下划线开头的目录，所以这些文件**不会**被发布到线上站点，只在仓库里留存。
- i18n 字典里对应的翻译 key 全部保留未删，恢复后界面文字可直接正常显示。
