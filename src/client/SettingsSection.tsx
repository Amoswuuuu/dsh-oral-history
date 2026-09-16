import React, { useCallback, useEffect, useState } from 'react';
import type { OralHistoryConfig, OralHistoryStats } from '../shared/types';
import { api } from './api';
import type { TFunc } from './nav';
import { Btn, Field, Icon, Icons, Input, SchStyles, T } from './ui';

/**
 * 设置面板。
 *
 * 注意：/oral-history/config 直接返回 config 对象本身（不是 {config} 包裹），
 * 与 /stats 一致——这是本插件的路由约定，别照抄 dsh-scholar 的包裹写法。
 */
export function OralHistorySettings({ t }: { t: TFunc }) {
  const [config, setConfig] = useState<OralHistoryConfig>({ dataDir: '' });
  const [stats, setStats] = useState<OralHistoryStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [c, s] = await Promise.all([
        api<OralHistoryConfig>('/oral-history/config'),
        api<OralHistoryStats>('/oral-history/stats'),
      ]);
      setConfig(c);
      setStats(s);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    try {
      setSaving(true);
      await api('/oral-history/config', {
        method: 'PUT',
        body: JSON.stringify({
          dataDir: config.dataDir,
          defaultTags: (config.defaultTags ?? []).filter((x) => x.trim()),
          fetchProxy: config.fetchProxy ?? '',
          openalexEmail: config.openalexEmail ?? '',
          defaultLanguage: config.defaultLanguage ?? '',
          asrEndpoint: config.asrEndpoint ?? '',
          glossaryPath: config.glossaryPath ?? '',
        }),
      });
      setMessage(t('settings.saved'));
      setError('');
      setTimeout(() => setMessage(''), 2500);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const corrupt = stats?.corruptFiles ?? [];

  return (
    <div style={{ padding: '14px 18px', fontSize: 12, maxWidth: 600 }}>
      <SchStyles />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{t('settings.title')}</span>
        <span style={{ flex: 1 }} />
        {message && <span style={{ color: T.success, fontSize: 11.5 }}>✓ {message}</span>}
        <Btn tone="primary" onClick={() => void save()} disabled={saving || loading}>
          {t('settings.save')}
        </Btn>
      </div>

      {loading && <div style={{ color: T.caption }}>{t('common.loading')}</div>}
      {error && <div style={{ color: T.danger, marginBottom: 8 }}>{error}</div>}

      {!loading && (
        <>
          <Field label={t('settings.dataDir')} hint={t('settings.dataDirHint')}>
            <Input value={config.dataDir ?? ''} onChange={(e) => setConfig({ ...config, dataDir: e.target.value })} />
          </Field>

          <Field label={t('settings.defaultTags')} hint={t('settings.defaultTagsHint')}>
            <Input
              value={(config.defaultTags ?? []).join(', ')}
              onChange={(e) => setConfig({
                ...config,
                defaultTags: e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
              })}
            />
          </Field>

          <Field label={t('settings.defaultLanguage')} hint={t('settings.defaultLanguageHint')}>
            <Input
              value={config.defaultLanguage ?? ''}
              placeholder="zh"
              onChange={(e) => setConfig({ ...config, defaultLanguage: e.target.value })}
            />
          </Field>

          <Field label={t('settings.asrEndpoint')} hint={t('settings.asrEndpointHint')}>
            <Input
              value={config.asrEndpoint ?? ''}
              placeholder="http://127.0.0.1:9000/asr"
              onChange={(e) => setConfig({ ...config, asrEndpoint: e.target.value })}
            />
          </Field>

          <Field label={t('settings.fetchProxy')} hint={t('settings.fetchProxyHint')}>
            <Input
              value={config.fetchProxy ?? ''}
              placeholder="http://127.0.0.1:7890"
              onChange={(e) => setConfig({ ...config, fetchProxy: e.target.value })}
            />
          </Field>

          <Field label={t('settings.openalexEmail')} hint={t('settings.openalexEmailHint')}>
            <Input
              value={config.openalexEmail ?? ''}
              placeholder="you@example.com"
              onChange={(e) => setConfig({ ...config, openalexEmail: e.target.value })}
            />
          </Field>

          {stats && (
            <div style={{
              marginTop: 14, display: 'flex', flexDirection: 'column', gap: 7,
              border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10,
              background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06))',
              padding: '10px 12px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: 11, color: T.secondary }}>
                <Icon d={Icons.archive} size={13} color={T.business} />
                <span>{t('settings.statsSources', { primary: stats.primary ?? 0, secondary: stats.secondary ?? 0 })}</span>
                <span style={{ color: T.caption }}>·</span>
                <span>{t('settings.statsInterviews', { n: stats.interviews ?? 0 })}</span>
                <span style={{ color: T.caption }}>·</span>
                <span>{t('settings.statsCards', { n: stats.cards ?? 0 })}</span>
                <span style={{ color: T.caption }}>·</span>
                <span>{t('settings.statsGraph', { nodes: stats.nodes ?? 0, edges: stats.edges ?? 0 })}</span>
              </div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: T.caption,
              }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={stats.dir}>
                  {stats.dir}
                </span>
              </div>
              {/* 未同步与损坏文件是数据完整性问题，必须显式提示而不是静默 */}
              {(stats.unsynced?.length ?? 0) > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: T.warning }}>
                  <Icon d={Icons.caution} size={12} color={T.warning} />
                  {t('settings.unsynced', { n: stats.unsynced?.length ?? 0 })}
                </div>
              )}
              {corrupt.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: T.danger }}>
                    <Icon d={Icons.caution} size={12} color={T.danger} />
                    {t('settings.corruptFiles', { n: corrupt.length })}
                  </div>
                  <div style={{ fontSize: 10, color: T.caption, paddingLeft: 18 }}>{t('settings.corruptHint')}</div>
                  <div style={{ fontSize: 10, color: T.caption, paddingLeft: 18, fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
                    {corrupt.slice(0, 8).join('、')}{corrupt.length > 8 ? ' …' : ''}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
