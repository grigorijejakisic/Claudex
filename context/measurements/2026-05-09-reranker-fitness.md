# Reranker Fitness Check — 2026-05-09

**Reranker URL:** `http://127.0.0.1:7439/rerank`
**Reachable:** yes
**Sample size:** 47
**Mean top-3 overlap:** 56.0%
**Threshold:** 60%
**Verdict:** BELOW THRESHOLD

## Per-query overlap distribution

  0/3:   3  ###
  1/3:  19  ###################
  2/3:  15  ###############
  3/3:  10  ##########

## Reading the verdict

Below threshold does NOT block ship. It informs P9: if cross-encoder
top-3 stability against the bi-encoder is < 60% on transcript-distribution
data, P9 uses bi-encoder-only as the baseline retrieval mode.
Above threshold means the cross-encoder is the safe P9 default.
