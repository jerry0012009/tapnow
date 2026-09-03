(() => {
  const DEFAULT_SETTINGS = {
    enabled: true,
    gateClicks: true,
    requiredTerms: [],
    forbiddenTerms: []
  };

  function normalizeSettings(settings = {}) {
    const splitTerms = (value) => {
      if (Array.isArray(value)) return value;
      return String(value ?? "")
        .split(/[,，\n]/)
        .map((term) => term.trim())
        .filter(Boolean);
    };

    return {
      enabled: settings.enabled !== false,
      gateClicks: settings.gateClicks !== false,
      requiredTerms: splitTerms(settings.requiredTerms),
      forbiddenTerms: splitTerms(settings.forbiddenTerms)
    };
  }

  function reviewDraft(draft = {}, settings = DEFAULT_SETTINGS) {
    const normalized = normalizeSettings(settings);
    const prompt = String(draft.prompt ?? "").trim();
    const issues = [];
    const suggestions = [];

    if (!prompt) {
      issues.push({
        severity: "block",
        code: "empty-prompt",
        title: "提示词为空",
        detail: "当前节点没有检测到可审核的提示词。"
      });
      suggestions.push("先补充这个节点的核心目标和输入内容。");
    } else if (prompt.length < 12) {
      issues.push({
        severity: "warn",
        code: "short-prompt",
        title: "提示词较短",
        detail: "信息可能不足，容易得到不稳定或不符合预期的结果。"
      });
      suggestions.push("补充主体、动作/目标、环境和风格等关键信息。");
    }

    for (const term of normalized.forbiddenTerms) {
      if (term && prompt.toLocaleLowerCase().includes(term.toLocaleLowerCase())) {
        issues.push({
          severity: "block",
          code: "forbidden-term",
          title: `命中团队禁用词：${term}`,
          detail: "请移除或替换该词后再运行。"
        });
      }
    }

    const lowerPrompt = prompt.toLocaleLowerCase();
    for (const term of normalized.requiredTerms) {
      if (term && !lowerPrompt.includes(term.toLocaleLowerCase())) {
        issues.push({
          severity: "warn",
          code: "missing-required-term",
          title: `缺少团队要求：${term}`,
          detail: "这是提醒，不会阻止本次运行。"
        });
      }
    }

    if (/(高质量|好看|高级感|尽量|随便|高品质|best quality|make it good)/i.test(prompt)) {
      issues.push({
        severity: "warn",
        code: "vague-quality",
        title: "包含模糊质量描述",
        detail: "这类描述通常不如可验证的视觉或业务要求稳定。"
      });
      suggestions.push("把模糊形容词改成可观察的构图、材质、光线或验收条件。");
    }

    const hasContext = Boolean(String(draft.upstreamSummary ?? "").trim());
    if (draft.nodeType === "image" && !hasContext) {
      issues.push({
        severity: "warn",
        code: "missing-upstream-context",
        title: "未检测到上游上下文",
        detail: "如果这个图片节点依赖前置文本或参考图，请确认连接和输入已经生效。"
      });
    }

    const decision = issues.some((issue) => issue.severity === "block")
      ? "block"
      : issues.length
        ? "warn"
        : "allow";

    return {
      decision,
      issues,
      suggestions: [...new Set(suggestions)],
      checkedAt: new Date().toISOString()
    };
  }

  globalThis.TapnowCompanionReviewer = {
    DEFAULT_SETTINGS,
    normalizeSettings,
    reviewDraft
  };
})();
