// 医学术语核心词库（0.11.0 医学专业模式）
// 只放经过审核、方向明确的条目；不要在这里塞未经核验的机器译名。
// 数据来源和许可证见 lib/medical/sources.js 与 docs/MEDICAL-DATA-AUDIT.md。
// reverse: true 表示来源术语库声明中英双向；只有 MIT 词表使用。
export const MEDICAL_LEXICON_VERSION = '1';

export const MEDICAL_TERMS = [
  {
    "source": "chronic obstructive pulmonary disease",
    "target": "慢性阻塞性肺疾病",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "respiratory",
    "sourceId": "wikidata:Q199804/P486:D029424",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "gestational trophoblastic neoplasia",
    "target": "妊娠滋养细胞肿瘤",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#gestational-trophoblastic-neoplasia",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "GTN"
  },
  {
    "source": "high-grade serous ovarian carcinoma",
    "target": "高级别浆液性卵巢癌",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#high-grade-serous-ovarian-carcinoma",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "HGSOC"
  },
  {
    "source": "cervical intraepithelial neoplasia",
    "target": "宫颈上皮内瘤变",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#cervical-intraepithelial-neoplasia",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "CIN"
  },
  {
    "source": "intraperitoneal chemotherapy",
    "target": "腹腔化疗",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#intraperitoneal-chemotherapy",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "IP chemo"
  },
  {
    "source": "pathologic complete response",
    "target": "病理完全缓解",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#pathologic-complete-response",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "pCR"
  },
  {
    "source": "immune checkpoint inhibitor",
    "target": "免疫检查点抑制剂",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#immune-checkpoint-inhibitor",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "ICI"
  },
  {
    "source": "intention-to-treat analysis",
    "target": "意向治疗分析",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#intention-to-treat-analysis",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "ITT"
  },
  {
    "source": "randomized controlled trial",
    "target": "随机对照试验",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#randomized-controlled-trial",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "RCT"
  },
  {
    "source": "microsatellite instability",
    "target": "微卫星不稳定",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#microsatellite-instability",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "MSI"
  },
  {
    "source": "mismatch repair deficiency",
    "target": "错配修复缺陷",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#mismatch-repair-deficiency",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "dMMR"
  },
  {
    "source": "platinum-resistant relapse",
    "target": "铂耐药复发",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#platinum-resistant-relapse",
    "status": "reviewed-upstream",
    "reverse": true
  },
  {
    "source": "platinum-sensitive relapse",
    "target": "铂敏感复发",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#platinum-sensitive-relapse",
    "status": "reviewed-upstream",
    "reverse": true
  },
  {
    "source": "epithelial ovarian cancer",
    "target": "上皮性卵巢癌",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#epithelial-ovarian-cancer",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "EOC"
  },
  {
    "source": "major depressive disorder",
    "target": "重性抑郁障碍",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "psychiatry",
    "sourceId": "wikidata:Q42844/P486:D003865",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "primary peritoneal cancer",
    "target": "原发性腹膜癌",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#primary-peritoneal-cancer",
    "status": "reviewed-upstream",
    "reverse": true
  },
  {
    "source": "progression-free survival",
    "target": "无进展生存期",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#progression-free-survival",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "PFS"
  },
  {
    "source": "propensity score matching",
    "target": "倾向评分匹配",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#propensity-score-matching",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "PSM"
  },
  {
    "source": "neoadjuvant chemotherapy",
    "target": "新辅助化疗",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#neoadjuvant-chemotherapy",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "NACT"
  },
  {
    "source": "objective response rate",
    "target": "客观缓解率",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#objective-response-rate",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "ORR"
  },
  {
    "source": "tumor mutational burden",
    "target": "肿瘤突变负荷",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#tumor-mutational-burden",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "TMB"
  },
  {
    "source": "endometrioid carcinoma",
    "target": "子宫内膜样癌",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#endometrioid-carcinoma",
    "status": "reviewed-upstream",
    "reverse": true
  },
  {
    "source": "adjuvant chemotherapy",
    "target": "辅助化疗",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#adjuvant-chemotherapy",
    "status": "reviewed-upstream",
    "reverse": true
  },
  {
    "source": "adverse drug reaction",
    "target": "药物不良反应",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "pharmacovigilance",
    "sourceId": "wikidata:Q45959/P486:D064420",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "fallopian tube cancer",
    "target": "输卵管癌",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#fallopian-tube-cancer",
    "status": "reviewed-upstream",
    "reverse": true
  },
  {
    "source": "multivariate analysis",
    "target": "多因素分析",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#multivariate-analysis",
    "status": "reviewed-upstream",
    "reverse": true
  },
  {
    "source": "myocardial infarction",
    "target": "心肌梗死",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "cardiology",
    "sourceId": "wikidata:Q12152/P486:D009203",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "optimal cytoreduction",
    "target": "满意减瘤",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#optimal-cytoreduction",
    "status": "reviewed-upstream",
    "reverse": true
  },
  {
    "source": "disease control rate",
    "target": "疾病控制率",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#disease-control-rate",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "DCR"
  },
  {
    "source": "immunohistochemistry",
    "target": "免疫组化",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "pathology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#immunohistochemistry",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "IHC"
  },
  {
    "source": "Alzheimer's disease",
    "target": "阿尔茨海默病",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "neurology",
    "sourceId": "wikidata:Q11081/P486:D000544",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "confidence interval",
    "target": "置信区间",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#confidence-interval",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "CI"
  },
  {
    "source": "Parkinson's disease",
    "target": "帕金森病",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "neurology",
    "sourceId": "wikidata:Q11085/P486:D010300",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "progressive disease",
    "target": "疾病进展",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#progressive-disease",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "PD"
  },
  {
    "source": "case-control study",
    "target": "病例对照研究",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "epidemiology",
    "sourceId": "wikidata:Q961652/P486:D016022",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "complete response",
    "target": "完全缓解",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#complete-response",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "CR"
  },
  {
    "source": "subgroup analysis",
    "target": "亚组分析",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#subgroup-analysis",
    "status": "reviewed-upstream",
    "reverse": true
  },
  {
    "source": "survival analysis",
    "target": "生存分析",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#survival-analysis",
    "status": "reviewed-upstream",
    "reverse": true
  },
  {
    "source": "contraindication",
    "target": "禁忌证",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "pharmacology",
    "sourceId": "wikidata:Q1848900/P486:D000075202",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "informed consent",
    "target": "知情同意",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "research-ethics",
    "sourceId": "wikidata:Q764527/P486:D007258",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "overall survival",
    "target": "总生存期",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#overall-survival",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "OS"
  },
  {
    "source": "partial response",
    "target": "部分缓解",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#partial-response",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "PR"
  },
  {
    "source": "pharmacokinetics",
    "target": "药代动力学",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "pharmacology",
    "sourceId": "wikidata:Q323936/P486:D010599",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "targeted therapy",
    "target": "靶向治疗",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#targeted-therapy",
    "status": "reviewed-upstream",
    "reverse": true
  },
  {
    "source": "cervical cancer",
    "target": "宫颈癌",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#cervical-cancer",
    "status": "reviewed-upstream",
    "reverse": true
  },
  {
    "source": "liver cirrhosis",
    "target": "肝硬化",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "hepatology",
    "sourceId": "wikidata:Q147778/P486:D008103",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "quality of life",
    "target": "生活质量",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "clinical-research",
    "sourceId": "wikidata:Q13100823/P486:D011788",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "uterine sarcoma",
    "target": "子宫肉瘤",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#uterine-sarcoma",
    "status": "reviewed-upstream",
    "reverse": true
  },
  {
    "source": "clinical trial",
    "target": "临床试验",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "clinical-research",
    "sourceId": "wikidata:Q30612/P486:D002986",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "ovarian cancer",
    "target": "卵巢癌",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#ovarian-cancer",
    "status": "reviewed-upstream",
    "reverse": true
  },
  {
    "source": "stable disease",
    "target": "疾病稳定",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#stable-disease",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "SD"
  },
  {
    "source": "vaginal cancer",
    "target": "阴道癌",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#vaginal-cancer",
    "status": "reviewed-upstream",
    "reverse": true
  },
  {
    "source": "heart failure",
    "target": "心力衰竭",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "cardiology",
    "sourceId": "wikidata:Q181754/P486:D006333",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "high-risk HPV",
    "target": "高危型HPV",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#high-risk-hpv",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "hrHPV"
  },
  {
    "source": "immunotherapy",
    "target": "免疫治疗",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "oncology",
    "sourceId": "wikidata:Q1427096/P486:D007167",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "meta-analysis",
    "target": "荟萃分析",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "wikidata:Q815382/P486:D015201",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "relative risk",
    "target": "相对危险度",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#relative-risk",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "RR"
  },
  {
    "source": "schizophrenia",
    "target": "精神分裂症",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "psychiatry",
    "sourceId": "wikidata:Q41112/P486:D012559",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "vulvar cancer",
    "target": "外阴癌",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "gyn-oncology",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#vulvar-cancer",
    "status": "reviewed-upstream",
    "reverse": true
  },
  {
    "source": "cohort study",
    "target": "队列研究",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "epidemiology",
    "sourceId": "wikidata:Q1778788/P486:D015331",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "epidemiology",
    "target": "流行病学",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "epidemiology",
    "sourceId": "wikidata:Q133805/P486:D004813",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "hazard ratio",
    "target": "风险比",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#hazard-ratio",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "HR"
  },
  {
    "source": "inflammation",
    "target": "炎症",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "pathology",
    "sourceId": "wikidata:Q101991/P486:D007249",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "tuberculosis",
    "target": "结核病",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "infectious-disease",
    "sourceId": "wikidata:Q12204/P486:D014376",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "comorbidity",
    "target": "合并症",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "clinical",
    "sourceId": "wikidata:Q1414874/P486:D015897",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "antibiotic",
    "target": "抗菌药",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "pharmacology",
    "sourceId": "wikidata:Q12187/P486:D000900",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "odds ratio",
    "target": "比值比",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "medical-statistics",
    "sourceId": "qitong:11c9604e758fe9bbcfc25ca90e14ae1a2d1c5176/glossary#odds-ratio",
    "status": "reviewed-upstream",
    "reverse": true,
    "abbreviation": "OR"
  },
  {
    "source": "physiology",
    "target": "生理学",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "physiology",
    "sourceId": "wikidata:Q521/P486:D010827",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "prevalence",
    "target": "患病率",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "epidemiology",
    "sourceId": "wikidata:Q719602/P486:D015995",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "biomarker",
    "target": "生物标志物",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "research",
    "sourceId": "wikidata:Q864574/P486:D015415",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "diagnosis",
    "target": "诊断",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "clinical",
    "sourceId": "wikidata:Q16644043/P486:D003933",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "hepatitis",
    "target": "肝炎",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "hepatology",
    "sourceId": "wikidata:Q131742/P486:D006505",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "incidence",
    "target": "发病率",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "epidemiology",
    "sourceId": "wikidata:Q217690/P486:D015994",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "infection",
    "target": "感染",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "infectious-disease",
    "sourceId": "wikidata:Q166231/P486:D007239",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "pathology",
    "target": "病理学",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "pathology",
    "sourceId": "wikidata:Q7208/P486:D010336",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "phenotype",
    "target": "表型",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "genetics",
    "sourceId": "wikidata:Q104053/P486:D010641",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "pneumonia",
    "target": "肺炎",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "respiratory",
    "sourceId": "wikidata:Q12192/P486:D011014",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "prognosis",
    "target": "预后",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "clinical",
    "sourceId": "wikidata:Q592442/P486:D011379",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "antibody",
    "target": "抗体",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "immunology",
    "sourceId": "wikidata:Q79460/P486:D000906",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "epilepsy",
    "target": "癫痫",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "neurology",
    "sourceId": "wikidata:Q41571/P486:D004827",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "genotype",
    "target": "基因型",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "genetics",
    "sourceId": "wikidata:Q106016/P486:D005838",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "leukemia",
    "target": "白血病",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "hematology",
    "sourceId": "wikidata:Q29496/P486:D007938",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "lymphoma",
    "target": "淋巴瘤",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "hematology",
    "sourceId": "wikidata:Q208414/P486:D008223",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "melanoma",
    "target": "黑色素瘤",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "oncology",
    "sourceId": "wikidata:Q180614/P486:D008545",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "mutation",
    "target": "突变",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "genetics",
    "sourceId": "wikidata:Q42918/P486:D009154",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "syndrome",
    "target": "综合征",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "clinical",
    "sourceId": "wikidata:Q179630/P486:D013577",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "anatomy",
    "target": "解剖学",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "anatomy",
    "sourceId": "wikidata:Q514/P486:D000715",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "hormone",
    "target": "激素",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "endocrinology",
    "sourceId": "wikidata:Q11364/P486:D006728",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "malaria",
    "target": "疟疾",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "infectious-disease",
    "sourceId": "wikidata:Q12156/P486:D008288",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "placebo",
    "target": "安慰剂",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "clinical-research",
    "sourceId": "wikidata:Q269829/P486:D010919",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "protein",
    "target": "蛋白质",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "biochemistry",
    "sourceId": "wikidata:Q8054/P486:D011506",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "vaccine",
    "target": "疫苗",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "immunology",
    "sourceId": "wikidata:Q134808/P486:D014612",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "allele",
    "target": "等位基因",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "genetics",
    "sourceId": "wikidata:Q80726/P486:D000483",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "anemia",
    "target": "贫血",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "hematology",
    "sourceId": "wikidata:Q5445/P486:D000740",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "asthma",
    "target": "哮喘",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "respiratory",
    "sourceId": "wikidata:Q35869/P486:D001249",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "biopsy",
    "target": "活检",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "pathology",
    "sourceId": "wikidata:Q179991/P486:D001706",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "enzyme",
    "target": "酶",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "biochemistry",
    "sourceId": "wikidata:Q8047/P486:D004798",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "sepsis",
    "target": "脓毒症",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "critical-care",
    "sourceId": "wikidata:Q183134/P486:D018805",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "gene",
    "target": "基因",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "genetics",
    "sourceId": "wikidata:Q7187/P486:D005796",
    "status": "reviewed",
    "reverse": false
  },
  {
    "source": "pain",
    "target": "疼痛",
    "sourceLang": "en",
    "targetLang": "zh-CN",
    "domain": "symptom",
    "sourceId": "wikidata:Q81938/P486:D010146",
    "status": "reviewed",
    "reverse": false
  }
];
