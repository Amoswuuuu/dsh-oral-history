# 转录准确率评估数据

这个目录里的数据用于**复现**报告中的字错率（CER）结论。
不含任何真实的访谈内容，全部来自公开语料。

## 内容

| 文件 | 说明 |
|---|---|
| `truth-aishell30.txt` | 金标准（参考）逐字稿，30 行，每行 `<音频id> <文本>` |
| `hyp/` | 机器转录结果，30 个 `<音频id>.txt` |

## 数据来源

- **音频**：AISHELL-1 公开中文语音数据集（Apache-2.0 授权）
  - 通过 ModelScope `speech_asr/speech_asr_aishell1_subset` 获取
  - 音频本体在 `../demo-data/zh-audio/`（60 条，本目录只用了有金标准的 30 条）
- **金标准文本**：AISHELL-1 官方转写 `aishell_transcript_v0.8.txt`
  - 通过 HuggingFace 镜像 `shenyunhang/AISHELL-1` 获取
- **机器转录**：whisper.cpp + `ggml-base.bin`，本机 CPU 推理（2 线程）

## 复现方法

```bash
node scripts/eval-asr.mjs --truth scripts/eval-data/truth-aishell30.txt \
                          --hyp   scripts/eval-data/hyp
```

预期输出：**字错率 24.1%，字准确率 75.9%**（30 条，464 字，编辑距离 112）。

## 重要说明

1. **这些是朗读语音，不是访谈口语。** AISHELL-1 是播音式朗读，
   与真实口述史（方言、口语冗余、老年受访者语速、老磁带音质）差距很大。
   **不要把 75.9% 直接外推到真实访谈场景。**

2. **样本量小。** 30 条、464 字只能作为基线参考，不足以做统计推断。

3. **机器转录保留原始形态。** `hyp/` 中的文本含繁体字和阿拉伯数字，
   是 whisper 的原始输出，未经后处理——这样才能看清真实的错误分布。

4. **评分口径**：`eval-asr.mjs` 在计算前会做繁简归一、全半角统一、标点与空白剔除。
   不做归一化时 CER 为 34.3%（繁体字会被大量计为错误）。

## 换成自己的数据

拿到真实访谈 + 精校稿后，按同样格式替换即可：

```
truth-mine.txt          # 每行：<音频id> <精校文本>
hyp-mine/               # 每个音频一个 <音频id>.txt
```

然后跑同一条命令，就能得到可与 75.9% 直接对比的数字。
