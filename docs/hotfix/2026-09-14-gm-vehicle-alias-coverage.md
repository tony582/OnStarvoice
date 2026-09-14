# 上汽通用品牌与车型别名覆盖

核验日期：2026-09-14。字典版本：`saic-gm-aliases-2026-09-14`。

覆盖范围为上汽通用公司名称、通用汽车母公司名称、别克／凯迪拉克／雪佛兰三品牌、安吉星服务，以及中国讨论场景常见的现有与历史车系名称。包括三品牌部分进口历史车型；识别品牌归属不等于认定该车型由上汽通用国产。它不是全球通用全部历史车型、配置款、民间昵称或未来新车的穷尽清单。

当前收录 96 条识别规则、261 个不重复别名，按标准名称合并为 66 组。强名称与需要语境的短名称拆行存储，因此“规则数”不能当作“车型数”。来源均为车企官网、官方新闻、参数手册或企业报告。繁简写法属于同名文字转换，不表示新增品牌或车型。

## 判断边界

- 别名命中只提供候选线索，仍结合主帖全文的 AI 相关性结论。不能只凭出现品牌名、字母或型号就认定相关。
- L7、E4、E5、E7、GT4 等可能跨品牌或具有其他含义；省略品牌不是自动拦截理由，需结合车辆／哨兵等上下文。明确讨论其他厂牌时不得冒认为别克或凯迪拉克。
- 世纪、世家、至境、开拓者、景程和 LaCrosse、Century、Regal、Envision、Encore、Enclave、Seeker、Tracker、Trailblazer、Orlando、Malibu、Monza、Menlo、Volt 等普通词／地名，需要车辆语境。
- GM／General Motors 指通用汽车公司；SAIC-GM 指上汽通用合资企业；SGM 在历史公司名称和官网条款中使用，需结合上下文。SAIC 单独不能等同上汽通用。“上汽通用五菱／SAIC-GM-Wuling／SGMW”是另一家合资企业，不能因包含“上汽通用／SAIC-GM／GM”子串就归入上汽通用三品牌。
- 昂科雷与昂科旗在不同市场／时期使用 Enclave 英文名；乐骋与爱唯欧在不同时期涉及 Aveo 名称。本字典保留名称族关系，不把它们断言为同一代车型。
- CT50 单独放在 `GM_COMPATIBLE_MODEL_SPELLINGS`，仅兼容用户确认的原文写法，不计入官方别名。不得宣称它是正式型号，也不得把原文 CT50 的证据截为 CT5。
- “雪弗兰”作为非标准写法兼容；[上汽集团官网企业信息](https://www.saicmotor.com/chinese/xxgk/ssqyxxgk/56637.shtml)的经营资质文字也出现“雪弗兰CHEVROLET”。这不改变正式品牌名称“雪佛兰”，也不把异写认定为另一个官方品牌名。
- 不臆造“凯迪”或 BK、KDLK、XFL 等口语及拼音首字母为官方简称；未登记写法必须结合主帖全文、被指向的品牌／车型及逐字引用判断，不凭首字母自动归品牌。新名称不能仅因尚未入表而判定无关，需走可核验原文实体判断。
- 大小写、空格、连字符、全角字符属于匹配层归一化；数据中的 aliases 是文字，不是正则表达式。

## 品牌、公司及服务

| 标准名称 | 可直接识别的名称 | 需要车辆语境的名称 | 官方来源 |
|---|---|---|---|
| 上汽通用汽车有限公司 | 上汽通用汽车有限公司、上汽通用汽车、上汽通用、上海通用汽车有限公司、上海通用汽车、上海通用、SAIC-GM、SAIC General Motors、SAIC General Motors Corporation Limited、Shanghai General Motors、Shanghai GM | SGM | [S1](https://www.saic-gm.com/)、[S2](https://www.gm.com.cn/en/home/company/operations.html)、[S3](https://www.saicmotor.com/chinese/images/tzzgx/ggb/lsgg/2009nlsgg/2856.pdf)、[S4](https://raa.oc.saic-gm.com/cmsraa/ue/index.html?cf=body&cmid=5fcf317c95c3c&id=61503f7cad7a6c26e7032ad7&sid=5c3c44cdb0e3e) |
| 通用汽车公司 | 通用汽车公司、通用汽车、通用汽車、General Motors、General Motors Company | GM、通用 | [S2](https://www.gm.com.cn/en/home/company/operations.html)、[S5](https://www.gm.com.cn/zh/home/company/operations.html) |
| 别克 | 别克、別克、Buick、上汽通用别克、上海通用别克 | — | [S6](https://www.gm.com.cn/en/home/brands.html)、[S3](https://www.saicmotor.com/chinese/images/tzzgx/ggb/lsgg/2009nlsgg/2856.pdf) |
| 凯迪拉克 | 凯迪拉克、凱迪拉克、Cadillac、上汽通用凯迪拉克、上海通用凯迪拉克 | — | [S6](https://www.gm.com.cn/en/home/brands.html)、[S3](https://www.saicmotor.com/chinese/images/tzzgx/ggb/lsgg/2009nlsgg/2856.pdf) |
| 雪佛兰 | 雪佛兰、雪佛蘭、雪弗兰（非标准写法兼容）、Chevrolet、Chevy、上汽通用雪佛兰、上海通用雪佛兰 | — | [S6](https://www.gm.com.cn/en/home/brands.html)、[S7](https://media.chevrolet.com/media/cn/en/chevrolet/home.html)、[S3](https://www.saicmotor.com/chinese/images/tzzgx/ggb/lsgg/2009nlsgg/2856.pdf)、[S55](https://www.saicmotor.com/chinese/xxgk/ssqyxxgk/56637.shtml) |
| 安吉星 | 安吉星、OnStar、上海安吉星 | — | [S1](https://www.saic-gm.com/)、[S8](https://www.saicmotor.com/chinese/xwzx/xwk/2017/49551.shtml) |

## 别克车型与系列

| 标准名称 | 可直接识别的名称 | 需要车辆语境的名称 | 官方来源 |
|---|---|---|---|
| 别克至境 | 别克至境、ELECTRA至境、Buick ELECTRA | 至境、ELECTRA | [S9](https://media.gm.com/media/cn/zh/buick/home.detail.html/content/Pages/news/cn/zh/2025/apr/0421-buick.html) |
| 别克艾维亚 | 艾维亚、艾維亞、Buick Avenir | Avenir | [S10](https://news.gm.com.cn/zh/home.detail.html/Pages/news/cn/zh/2021/Jul/0720-buick.html) |
| 别克GL8 | GL8、GL8 ES、GL8陆尊、GL8 ES陆尊、GL8艾维亚、GL8 Avenir、GL8 Legacy、GL8商旅车、陆尊、陸尊 | — | [S11](https://news.gm.com.cn/zh/home.detail.html/Pages/news/cn/zh/2022/Aug/0819-buick-gl8.html)、[S12](https://www.gm.com.cn/zh/home/newsroom.detail.html/Pages/news/cn/zh/2025/mar/0317-buick.html)、[S13](https://media.gm.com/media/cn/en/buick/home.html) |
| 别克GL8陆尚 | GL8陆尚、陆尚、GL8 Lu Shang | — | [S12](https://www.gm.com.cn/zh/home/newsroom.detail.html/Pages/news/cn/zh/2025/mar/0317-buick.html)、[S13](https://media.gm.com/media/cn/en/buick/home.html) |
| 别克GL6 | GL6 | — | [S8](https://www.saicmotor.com/chinese/xwzx/xwk/2017/49551.shtml) |
| 别克世纪 | 别克世纪、世纪CENTURY、Buick Century、GL8 Century | 世纪、世紀、Century | [S14](https://news.gm.com.cn/zh/home.detail.html/Pages/news/cn/zh/2022/Nov/1103-buick-century.html)、[S13](https://media.gm.com/media/cn/en/buick/home.html) |
| 别克ELECTRA E4 | ELECTRA E4、别克E4 | E4 | [S15](https://news.gm.com.cn/zh/home.detail.html/Pages/news/cn/zh/2023/Jun/0612-buick.html) |
| 别克ELECTRA E5 | ELECTRA E5、别克E5 | E5 | [S15](https://news.gm.com.cn/zh/home.detail.html/Pages/news/cn/zh/2023/Jun/0612-buick.html) |
| 别克至境L7 | 至境L7、ELECTRA L7、别克L7 | L7 | [S16](https://www.gm.com.cn/zh/home/newsroom.detail.html/Pages/news/cn/zh/2025/jul/0717-buick.html)、[S17](https://investor.gm.com/news-releases/news-release-details/gm-china-reports-record-nev-sales-2025) |
| 别克至境E7 | 至境E7、ELECTRA E7、别克E7 | E7 | [S18](https://news.gm.com.cn/zh/home.detail.html/Pages/news/cn/zh/2026/april/0422-buick.html)、[S19](https://news.gm.com.cn/en/home.detail.html/Pages/news/cn/en/2026/april/0422-buick.html) |
| 别克至境世家 | 至境世家、别克世家、ELECTRA ENCASA、ENCASA | 世家 | [S16](https://www.gm.com.cn/zh/home/newsroom.detail.html/Pages/news/cn/zh/2025/jul/0717-buick.html)、[S18](https://news.gm.com.cn/zh/home.detail.html/Pages/news/cn/zh/2026/april/0422-buick.html)、[S17](https://investor.gm.com/news-releases/news-release-details/gm-china-reports-record-nev-sales-2025) |
| 别克君越 | 君越、Buick LaCrosse | LaCrosse | [S13](https://media.gm.com/media/cn/en/buick/home.html)、[S3](https://www.saicmotor.com/chinese/images/tzzgx/ggb/lsgg/2009nlsgg/2856.pdf) |
| 别克君威 | 君威、君威GS、Buick Regal | Regal、Regal GS | [S20](https://media.gm.com/content/dam/Media/documents/CN/Vehicle_Spec/New_Regal.pdf)、[S3](https://www.saicmotor.com/chinese/images/tzzgx/ggb/lsgg/2009nlsgg/2856.pdf) |
| 别克昂科威 | 昂科威、昂科威S、昂科威Plus、Buick Envision、Envision S、Envision Plus | Envision | [S21](https://media.gm.com/media/cn/zh/buick/photos.detail.html/content/Pages/galleries/CN/zh/passengerCars/buick/envision.html)、[S13](https://media.gm.com/media/cn/en/buick/home.html) |
| 别克昂科拉 | 昂科拉、昂科拉GX、昂科拉Plus、Buick Encore、Encore GX、Encore Plus | Encore | [S13](https://media.gm.com/media/cn/en/buick/home.html)、[S22](https://www.gmignitionupdate.com/dld/content/media/us/en/buick/company_info/_jcr_content/rightpar/sectioncontainer_3/par/download_0/file.res/Buick-in-China-Overview.pdf) |
| 别克昂科旗 / 昂科雷 | 昂科旗、昂科雷、Buick Enclave | Enclave | [S23](https://media.gmc.com/Pages/galleries/CN/bilingual/passenger-cars/Buick/enclave/2019.html)、[S3](https://www.saicmotor.com/chinese/images/tzzgx/ggb/lsgg/2009nlsgg/2856.pdf)、[S22](https://www.gmignitionupdate.com/dld/content/media/us/en/buick/company_info/_jcr_content/rightpar/sectioncontainer_3/par/download_0/file.res/Buick-in-China-Overview.pdf) |
| 别克威朗 | 威朗、威朗Pro、威朗GS、Verano、Verano Pro、Verano GS | — | [S24](https://media.gm.com/Pages/galleries/CN/bilingual/passenger-cars/Buick/verano/2020.html)、[S25](https://news.gm.com.cn/zh/home.detail.html/Pages/news/cn/zh/2021/Apr/0418-buick-verano-pro.html/) |
| 别克凯越 | 凯越、凱越、凯越HRV、Excelle、Excelle HRV | — | [S22](https://www.gmignitionupdate.com/dld/content/media/us/en/buick/company_info/_jcr_content/rightpar/sectioncontainer_3/par/download_0/file.res/Buick-in-China-Overview.pdf)、[S3](https://www.saicmotor.com/chinese/images/tzzgx/ggb/lsgg/2009nlsgg/2856.pdf) |
| 别克英朗 | 英朗、英朗GT、英朗XT、Excelle GT、Excelle XT | — | [S26](https://media.buick.com/dld/content/dam/Media/documents/CN/CSR-Annual-Report/2010%20GM%20China%20CSR%20Report.pdf)、[S8](https://www.saicmotor.com/chinese/xwzx/xwk/2017/49551.shtml) |
| 别克阅朗 | 阅朗、閱朗、Excelle GX | — | [S27](https://www.gm.com.cn/content/dam/company/cn/pdf/csr/GM%20China%202018%20CSR%20Report-EN.pdf)、[S8](https://www.saicmotor.com/chinese/xwzx/xwk/2017/49551.shtml) |
| 别克微蓝 | 微蓝、微藍、VELITE、VELITE 5、VELITE 6、微蓝6 | — | [S28](https://www.saicmotor.com/m/xwzx/xwk/2019/52461.shtml)、[S29](https://www.saicmotor.com/chinese/xwzx/xwk/2017/index.shtml) |
| 别克微蓝7 | 微蓝7、微藍7、VELITE 7 | — | [S30](https://news.gm.com.cn/en/home.detail.html/Pages/news/cn/en/2021/Nov/1125-buick.html/)、[S31](https://www.saicmotor.com/m/xwzx/xwk/2020/53797.shtml) |
| 别克林荫大道 | 林荫大道、林蔭大道、Buick Park Avenue | Park Avenue | [S3](https://www.saicmotor.com/chinese/images/tzzgx/ggb/lsgg/2009nlsgg/2856.pdf)、[S32](https://media.gm.com/dld/content/Pages/presskits/in/en/GM/2014-New-Delhi-Auto-Show/_jcr_content/rightpar/sectioncontainer_0/par/download/file.res/Lowell%20Paddock.pdf) |

## 凯迪拉克车型与系列

| 标准名称 | 可直接识别的名称 | 需要车辆语境的名称 | 官方来源 |
|---|---|---|---|
| 凯迪拉克CT4 | CT4 | — | [S33](https://www.cadillac.com.cn/)、[S34](https://www.cadillac.com.cn/config/xts.html) |
| 凯迪拉克CT5 | CT5 | — | [S33](https://www.cadillac.com.cn/)、[S34](https://www.cadillac.com.cn/config/xts.html) |
| 凯迪拉克CT6 | CT6 | — | [S33](https://www.cadillac.com.cn/)、[S34](https://www.cadillac.com.cn/config/xts.html) |
| 凯迪拉克XT4 | XT4 | — | [S33](https://www.cadillac.com.cn/)、[S34](https://www.cadillac.com.cn/config/xts.html) |
| 凯迪拉克XT5 | XT5 | — | [S33](https://www.cadillac.com.cn/)、[S34](https://www.cadillac.com.cn/config/xts.html) |
| 凯迪拉克XT6 | XT6 | — | [S33](https://www.cadillac.com.cn/)、[S34](https://www.cadillac.com.cn/config/xts.html) |
| 凯迪拉克GT4 | Cadillac GT4、凯迪拉克GT4 | GT4 | [S35](https://media.cadillac.com/media/cn/en/cadillac/news.detail.html/content/Pages/news/cn/en/2023/May/0528-cadillac.html) |
| 凯迪拉克锐歌 | LYRIQ、LYRIQ-V、锐歌、銳歌、IQ锐歌 | — | [S34](https://www.cadillac.com.cn/config/xts.html)、[S36](https://media.cadillac.com/media/cn/zh/cadillac/news.detail.html/content/Pages/news/cn/zh/2025/apr/0423-cadillac.html) |
| 凯迪拉克傲歌 | OPTIQ、傲歌、IQ傲歌、OPTIQ傲歌 | — | [S33](https://www.cadillac.com.cn/)、[S36](https://media.cadillac.com/media/cn/zh/cadillac/news.detail.html/content/Pages/news/cn/zh/2025/apr/0423-cadillac.html) |
| 凯迪拉克凯威德 | VISTIQ、凯威德、凱威德 | — | [S33](https://www.cadillac.com.cn/) |
| 凯迪拉克凯雷德 | ESCALADE、ESCALADE IQ、凯雷德、凱雷德 | — | [S36](https://media.cadillac.com/media/cn/zh/cadillac/news.detail.html/content/Pages/news/cn/zh/2025/apr/0423-cadillac.html)、[S37](https://www.cadillac.com/legacy-vehicles) |
| 凯迪拉克ATS-L | ATS-L | — | [S38](https://www.cadillac.com.cn/wap/atsl/configuration.html)、[S39](https://www.cadillac.com.cn/active/vlab/) |
| 凯迪拉克ATS | — | ATS | [S37](https://www.cadillac.com/legacy-vehicles) |
| 凯迪拉克XTS | XTS | — | [S34](https://www.cadillac.com.cn/config/xts.html)、[S39](https://www.cadillac.com.cn/active/vlab/) |
| 凯迪拉克SRX | SRX | — | [S39](https://www.cadillac.com.cn/active/vlab/) |
| 凯迪拉克CTS | — | CTS、CTS-V | [S3](https://www.saicmotor.com/chinese/images/tzzgx/ggb/lsgg/2009nlsgg/2856.pdf)、[S37](https://www.cadillac.com/legacy-vehicles) |
| 凯迪拉克SLS | — | SLS、SLS赛威、赛威 | [S3](https://www.saicmotor.com/chinese/images/tzzgx/ggb/lsgg/2009nlsgg/2856.pdf)、[S32](https://media.gm.com/dld/content/Pages/presskits/in/en/GM/2014-New-Delhi-Auto-Show/_jcr_content/rightpar/sectioncontainer_0/par/download/file.res/Lowell%20Paddock.pdf) |

## 雪佛兰车型与系列

| 标准名称 | 可直接识别的名称 | 需要车辆语境的名称 | 官方来源 |
|---|---|---|---|
| 雪佛兰科鲁泽 | 科鲁泽、科魯澤、Chevrolet Monza | Monza | [S40](https://www.chevrolet.com.cn/pdf/monza2022.pdf)、[S7](https://media.chevrolet.com/media/cn/en/chevrolet/home.html) |
| 雪佛兰科鲁兹 | 科鲁兹、科魯茲、Cruze | — | [S3](https://www.saicmotor.com/chinese/images/tzzgx/ggb/lsgg/2009nlsgg/2856.pdf)、[S41](https://media.chevrolet.com/content/dam/Media/images/INTL/chevrolet/company-tab/2013/history/chevrolet_history_en_2013.pdf) |
| 雪佛兰科沃兹 | 科沃兹、科沃茲、Chevrolet Cavalier | Cavalier | [S42](https://www.saicmotor.com/m/xwzx/xwk/2016/45035.shtml) |
| 雪佛兰Onix | Onix | — | [S43](https://media.gm.com/content/dam/Media/gmcom/investor/2019/apr/gm-q1-2019-earnings-press-release-04-30.pdf) |
| 雪佛兰迈锐宝 | 迈锐宝、邁銳寶、迈锐宝XL、Chevrolet Malibu、Malibu XL | Malibu | [S44](https://www.saicmotor.com/chinese/history/w1.html)、[S41](https://media.chevrolet.com/content/dam/Media/images/INTL/chevrolet/company-tab/2013/history/chevrolet_history_en_2013.pdf) |
| 雪佛兰探界者 | 探界者、Chevrolet Equinox、Equinox Plus | Equinox | [S45](https://www.chevrolet.com.cn/pdf/equinox.pdf)、[S7](https://media.chevrolet.com/media/cn/en/chevrolet/home.html) |
| 雪佛兰星迈罗 | 星迈罗、星邁羅、Chevrolet Seeker | Seeker | [S46](https://m.chevrolet.com.cn/pdf/seeker.pdf)、[S7](https://media.chevrolet.com/media/cn/en/chevrolet/home.html) |
| 雪佛兰畅巡 | 畅巡、暢巡、Chevrolet Menlo | Menlo | [S7](https://media.chevrolet.com/media/cn/en/chevrolet/home.html)、[S47](https://media.chevrolet.com/media/cn/zh/chevrolet/home.html) |
| 雪佛兰创酷 | 创酷、創酷、创酷RS、Trax、Chevrolet Tracker、Tracker RS | Tracker | [S48](https://media.gm.com/Pages/galleries/CN/zh/passengerCars/chevrolet/TRAX.html)、[S7](https://media.chevrolet.com/media/cn/en/chevrolet/home.html) |
| 雪佛兰创界 | 创界、創界、Chevrolet Trailblazer | Trailblazer | [S49](https://www.saicmotor.com/m/xwzx/xwk/2019/52295.shtml) |
| 雪佛兰沃兰多 | 沃兰多、沃蘭多、Chevrolet Orlando | Orlando | [S50](https://media.gm.com/content/dam/Media/documents/CN/Vehicle_Spec/Chevrolet/Orlando/Chevrolet%20Orlando%20Specifications%20and%20Features.pdf) |
| 雪佛兰开拓者 | 雪佛兰开拓者、Chevrolet Blazer | 开拓者、開拓者、Blazer | [S51](https://www.saicmotor.com/m/xwzx/xwk/2019/52550.shtml) |
| 雪佛兰景程 | 雪佛兰景程、Chevrolet Epica | 景程、Epica | [S44](https://www.saicmotor.com/chinese/history/w1.html)、[S32](https://media.gm.com/dld/content/Pages/presskits/in/en/GM/2014-New-Delhi-Auto-Show/_jcr_content/rightpar/sectioncontainer_0/par/download/file.res/Lowell%20Paddock.pdf) |
| 雪佛兰赛欧 | 赛欧、賽歐、赛欧3、Chevrolet Sail | Sail、Sail 3 | [S44](https://www.saicmotor.com/chinese/history/w1.html)、[S26](https://media.buick.com/dld/content/dam/Media/documents/CN/CSR-Annual-Report/2010%20GM%20China%20CSR%20Report.pdf)、[S52](https://www.gm.com.cn/content/dam/company/cn/pdf/csr/2015_CSR_Report_EN.pdf) |
| 雪佛兰科帕奇 | 科帕奇、Captiva | — | [S3](https://www.saicmotor.com/chinese/images/tzzgx/ggb/lsgg/2009nlsgg/2856.pdf)、[S41](https://media.chevrolet.com/content/dam/Media/images/INTL/chevrolet/company-tab/2013/history/chevrolet_history_en_2013.pdf) |
| 雪佛兰乐风 | 乐风、樂風、LOVA、LOVA RV | — | [S44](https://www.saicmotor.com/chinese/history/w1.html)、[S52](https://www.gm.com.cn/content/dam/company/cn/pdf/csr/2015_CSR_Report_EN.pdf) |
| 雪佛兰乐骋 / 爱唯欧 | 乐骋、樂騁、爱唯欧、愛唯歐、Aveo | — | [S44](https://www.saicmotor.com/chinese/history/w1.html)、[S41](https://media.chevrolet.com/content/dam/Media/images/INTL/chevrolet/company-tab/2013/history/chevrolet_history_en_2013.pdf)、[S53](https://www.saicmotor.com/chinese/download/2011.pdf) |
| 雪佛兰科迈罗 | 科迈罗、科邁羅、Camaro | — | [S49](https://www.saicmotor.com/m/xwzx/xwk/2019/52295.shtml)、[S41](https://media.chevrolet.com/content/dam/Media/images/INTL/chevrolet/company-tab/2013/history/chevrolet_history_en_2013.pdf) |
| 雪佛兰科尔维特 | 科尔维特、科爾維特、Corvette | — | [S49](https://www.saicmotor.com/m/xwzx/xwk/2019/52295.shtml)、[S41](https://media.chevrolet.com/content/dam/Media/images/INTL/chevrolet/company-tab/2013/history/chevrolet_history_en_2013.pdf) |
| 雪佛兰沃蓝达 | 沃蓝达、沃藍達、Chevrolet Volt | Volt | [S54](https://media.gm.com/content/dam/Media/documents/CN/Vehicle_Spec/New%20Volt_SPEC.pdf) |

## 维护与验证口径

本表记录词汇覆盖和来源，不声明销售状态或当前在售配置。后续新增型号应先核对车企来源，再加入对应品牌与别名；跨品牌简称和普通词保留语境标记。测试需覆盖整表别名与文字变体，同时包含其他品牌、非车辆普通词、伪造引用、来源不在主帖等反例。完整功能回归结果记录在同目录 hotfix 变更与验收说明中。
