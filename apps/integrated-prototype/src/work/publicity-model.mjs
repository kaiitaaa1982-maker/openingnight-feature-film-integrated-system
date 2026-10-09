// 宣伝画面（施策・露出・指標観測）を選択作品で絞り、名称で表示するための純関数。
// サーバーの一覧は案件の権限で絞られるだけなので、同じ案件の別作品の行が混ざる。
// 露出は施策経由、観測は露出→施策経由で作品に結び付く。

const GRANULARITY = { day: '日', week: '週', month: '月', event: '露出単位', unknown: '未確認' };
const VERIFICATION = { verified: '確認済み', unverified: '未確認' };
const PAID_ORGANIC = { paid: '広告', organic: '自然', mixed: '混在', unknown: '未確認' };

export function campaignsForWork(campaigns, workId) {
  const id = Number(workId);
  return (campaigns || []).filter(row => Number(row.work_id) === id);
}

export function exposuresForWork(exposures, campaigns, workId) {
  const ids = new Set(campaignsForWork(campaigns, workId).map(row => Number(row.id)));
  return (exposures || []).filter(row => ids.has(Number(row.campaign_id)));
}

export function observationsForWork(observations, exposures, campaigns, workId) {
  const ids = new Set(exposuresForWork(exposures, campaigns, workId).map(row => Number(row.id)));
  return (observations || []).filter(row => ids.has(Number(row.exposure_id)));
}

// 3つの一覧をまとめて選択作品に絞る。
export function publicityForWork({ campaigns = [], exposures = [], observations = [] } = {}, workId) {
  const ownCampaigns = campaignsForWork(campaigns, workId);
  const ownExposures = exposuresForWork(exposures, ownCampaigns, workId);
  return { campaigns: ownCampaigns, exposures: ownExposures, observations: observationsForWork(observations, ownExposures, ownCampaigns, workId) };
}

// タイムゾーン付きの値（取得日時など）は日本時間に直す。datetime-local の入力値はそのまま読む。
export function displayDateTime(value) {
  if (!value) return '未確認';
  const text = String(value);
  if (/(Z|[+-]\d\d:?\d\d)$/.test(text)) {
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return text;
    const jst = new Date(date.getTime() + 9 * 3600_000).toISOString();
    return `${jst.slice(0, 10).replaceAll('-', '/')} ${jst.slice(11, 16)}`;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(text);
  return match ? `${match[1]}/${match[2]}/${match[3]}${match[4] ? ` ${match[4]}` : ''}` : text;
}

export function campaignName(campaigns, campaignId) {
  return (campaigns || []).find(row => Number(row.id) === Number(campaignId))?.name || '施策未登録';
}

// 「施策名｜媒体」
export function exposureLabel(exposure, campaigns) {
  if (!exposure) return '露出未登録';
  return `${campaignName(campaigns, exposure.campaign_id)}｜${exposure.medium || '媒体未登録'}`;
}

// 「表示回数（回）」
export function metricLabel(metric) {
  if (!metric) return '指標未登録';
  return `${metric.label}（${metric.unit || '単位なし'}）`;
}

export function observationValue(observation, metric) {
  if (observation.value_number != null) {
    const number = Number(observation.value_number);
    return `${Number.isFinite(number) ? number.toLocaleString('ja-JP') : observation.value_number}${metric?.unit ? ` ${metric.unit}` : ''}`;
  }
  if (observation.value_text != null && observation.value_text !== '') return String(observation.value_text);
  return '未確認';
}

// 露出の一覧表示用の行（見出しは日本語。IDは出さない）。
export function exposureRows(exposures, campaigns) {
  return (exposures || []).map(row => ({
    施策: campaignName(campaigns, row.campaign_id),
    媒体: row.medium || '未登録',
    素材版: row.asset_version || '—',
    予定日時: row.scheduled_at ? displayDateTime(row.scheduled_at) : '—',
    実施日時: row.happened_at ? displayDateTime(row.happened_at) : '—',
    地域: row.region || '未確認',
    出典: row.source_url || '—'
  }));
}

// 指標観測の一覧表示用の行。露出は「施策名｜媒体」、指標は名称で出す。
export function observationRows(observations, exposures, campaigns, metrics) {
  const exposureById = new Map((exposures || []).map(row => [Number(row.id), row]));
  const metricById = new Map((metrics || []).map(row => [Number(row.id), row]));
  return (observations || []).map(row => {
    const exposure = exposureById.get(Number(row.exposure_id)), metric = metricById.get(Number(row.metric_definition_id));
    return {
      施策: exposure ? campaignName(campaigns, exposure.campaign_id) : '施策未登録',
      媒体: exposure?.medium || '未登録',
      指標: metric?.label || '指標未登録',
      期間: `${displayDateTime(row.period_from)}〜${displayDateTime(row.period_to)}`,
      粒度: GRANULARITY[row.granularity] || '未確認',
      値: observationValue(row, metric),
      確認状態: VERIFICATION[row.verification] || '未確認',
      広告区分: PAID_ORGANIC[row.paid_organic] || '未確認',
      取得日時: displayDateTime(row.acquired_at),
      地域: row.region || '未確認',
      出典: row.source || '—'
    };
  });
}
