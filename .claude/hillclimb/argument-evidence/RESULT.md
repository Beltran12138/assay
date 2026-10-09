# argument_evidence eval · baseline 结果（2026-10-09）

**方向性 eval**：人与人的标签 MAE 为 0.25（第 2 轮），差异小于约 0.5 一律不采信，不用来 hillclimb。
判分方式：judge 给 s∈[0,1]，与 0-3 标签比 |3s−label|。43 例 × 3 rep。judge = 官方 api.deepseek.com `deepseek-flash`（DeepSeek-V4.1-Flash），prompt = `lib/assay/argument-prompt.ts` 的 `scorePrompt`，原样调用。

| | baseline（thinking 关） | v1（thinking 开） |
|---|---|---|
| MAE（按案例 bootstrap 95% CI） | 0.527 [0.40, 0.67] | 0.831 [0.66, 1.02] |
| 带符号偏差 3s−label | **−0.47** [−0.63, −0.32] | **−0.82** [−1.01, −0.65] |
| 案例级 Spearman | 0.78 | 0.59 |
| exact / within-1 | 0.70 / 0.98 | 0.32 / 0.86 |
| 重测：sd>0 的案例 | 19/43（最大 0.35） | 21/43（最大 0.35） |
| tokens 入/出 | 45,786 / 355 | 49,140 / 53,961 |
| 费用（高峰价） | $0.014 | $0.080 |
| 延迟中位数 | 1.0 s | 2.9 s |

参照线：多数类常数（恒为 1）MAE 0.488；人与人 MAE 0.25；null（恒 0.5）0.756；oracle 0。
配对差 v1 − baseline：MAE **+0.305** [+0.22, +0.39]。小于 0.5，按预注册规则只算方向。

## 读法

1. **预注册预测被推翻**。预测是「无锚点 judge 会系统性打高分」，实测两种模式都系统性打低分，CI 全在负区间。类比「用户第 1 轮凭感觉打高分」不成立。
2. **排序好，刻度偏**：baseline 的 Spearman 0.78，但均值 3s 按标签 0/1/2/3 分别是 0.14/0.63/0.80/1.60，整体被压到量表下半段。MAE 没赢过「恒为 1」的常数基线（0.527 vs 0.488，CI 重叠），**原因是刻度错位，不是排序差**。下一个值得测的改动是在 prompt 里写进 0-3 锚点，这是 rubric 未定义问题在 judge 侧的直接对应。
3. **开思考更差**：更严、排序也更乱，花 5.6 倍的钱。方向一致但 Δ<0.5，只作方向。
4. 合成样本 MAE 0.17，真实回答 0.64：低分段容易，误差集中在真实长文。

## 过程中拦下的问题（都按设计进了 errors 或 truncated，没有算成 0 分）

- `.env.local` 的路由器（gonkarouter）请求 `DeepSeek-V4-Flash-0731`，5 条里 4 条实际由 `MiniMax-M2.7` 回答，被 served-model 断言拦下；剩 1 条复读到 max_tokens（pilot/、pilot2/、pilot3/、pilot4/ 是这些排查的原始记录）。
- 官方端点把 `deepseek-chat` 解析为 `deepseek-flash`；为了让断言不靠猜别名，改为直接请求 `deepseek-flash`，用 `thinking` 参数区分两种模式。

## 局限

标签由 Claude 标注（用户第 2 轮盲标：exact 75%、κ 0.82、用户平均高 0.08，未过 80% 预注册门槛）。偏差方向不太可能是标签造成的：用户标得比 Claude 略高，换用户标签只会让负偏差更大。
