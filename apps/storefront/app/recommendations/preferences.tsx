'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, unwrap } from '@eventflow/api-client';
import {
  recommendationProfileSchema,
  recommendationInterestsSchema,
  recommendationPageSchema,
  type RecommendationProfile,
} from '@eventflow/event-contracts';
import { Alert, Button } from '@eventflow/ui';
import { BookingProvider, useBuyer } from '../booking/client';
import { RecommendationCards } from './cards';

function Interests({ profile }: { profile: RecommendationProfile }) {
  const { api, session } = useBuyer();
  const client = useQueryClient();
  const [draft, setDraft] = useState({ revision: profile.revision, interests: profile.interests });
  const options = useQuery({
    queryKey: ['recommendation-interests'],
    queryFn: async ({ signal }) =>
      recommendationInterestsSchema.parse(
        unwrap(await api.client.GET('/api/v1/recommendations/interests', { signal })),
      ),
  });
  const save = useMutation({
    mutationFn: async () =>
      recommendationProfileSchema.parse(
        unwrap(await api.client.PUT('/api/v1/recommendations/profile', { body: draft })),
      ),
    onSuccess: (value) => {
      setDraft({ revision: value.revision, interests: value.interests });
      void client.invalidateQueries({
        queryKey: ['recommendation-profile', session.data?.user?.sub],
      });
    },
    onError: () => {
      void client.invalidateQueries({
        queryKey: ['recommendation-profile', session.data?.user?.sub],
      });
    },
  });
  return (
    <section className="preference-panel">
      <h2>Ваши интересы</h2>
      <p>Выберите до 8 тем. Подборка учитывает только этот выбор и избранное.</p>
      {options.isPending && <p role="status">Загружаем темы…</p>}
      {options.isError && (
        <Alert>
          Не удалось загрузить темы.{' '}
          <Button onClick={() => void options.refetch()}>Повторить</Button>
        </Alert>
      )}
      <fieldset disabled={save.isPending}>
        <legend>Темы мероприятий</legend>
        <div className="interest-options">
          {options.data?.interests.map((item) => (
            <label key={item.id}>
              <input
                type="checkbox"
                checked={draft.interests.includes(item.id)}
                disabled={!draft.interests.includes(item.id) && draft.interests.length >= 8}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    interests: e.target.checked
                      ? [...draft.interests, item.id]
                      : draft.interests.filter((id) => id !== item.id),
                  })
                }
              />
              {item.title}
            </label>
          ))}
        </div>
      </fieldset>
      <Button disabled={save.isPending || !options.data} onClick={() => save.mutate()}>
        Сохранить интересы
      </Button>
      {save.isSuccess && <p role="status">Интересы сохранены.</p>}
      {save.error && (
        <Alert>
          {save.error instanceof ApiRequestError
            ? save.error.message
            : 'Не удалось сохранить интересы.'}
          {save.error instanceof ApiRequestError &&
            save.error.problem.code === 'PROFILE_CHANGED' && (
              <Button
                variant="secondary"
                onClick={() => {
                  setDraft({ revision: profile.revision, interests: profile.interests });
                  save.reset();
                }}
              >
                Загрузить сохранённый выбор
              </Button>
            )}
        </Alert>
      )}
    </section>
  );
}

function PersonalFeed({ actor, profile }: { actor: string; profile: RecommendationProfile }) {
  const { api } = useBuyer();
  const initial =
    typeof window === 'undefined'
      ? new URLSearchParams()
      : new URLSearchParams(window.location.search);
  const [filters, setFilters] = useState(() => ({
    city: initial.get('city') ?? '',
    from: initial.get('from') ?? '',
    to: initial.get('to') ?? '',
    budget: initial.get('budget') ?? '',
  }));
  const [query, setQuery] = useState(filters);
  const feed = useQuery({
    queryKey: ['personal-recommendations', actor, profile.revision, query],
    queryFn: async ({ signal }) =>
      recommendationPageSchema.parse(
        unwrap(
          await api.client.GET('/api/v1/recommendations/me', {
            signal,
            params: {
              query: {
                limit: 12,
                ...(query.city ? { city: query.city } : {}),
                ...(query.from ? { from: query.from } : {}),
                ...(query.to ? { to: query.to } : {}),
                ...(query.budget ? { maxPriceMinor: Math.round(Number(query.budget) * 100) } : {}),
              },
            },
          }),
        ),
      ),
  });
  return (
    <section className="recommendations-section">
      <h2>Для вас</h2>
      <form
        className="catalog-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(filters);
          const url = new URL(window.location.href);
          for (const [key, value] of Object.entries(filters)) {
            if (value) url.searchParams.set(key, value);
            else url.searchParams.delete(key);
          }
          window.history.replaceState(null, '', url);
        }}
      >
        <label>
          Город
          <input
            value={filters.city}
            maxLength={100}
            onChange={(e) => setFilters({ ...filters, city: e.target.value })}
          />
        </label>
        <label>
          С даты
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          />
        </label>
        <label>
          По дату
          <input
            type="date"
            value={filters.to}
            min={filters.from}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          />
        </label>
        <label>
          Бюджет, EUR
          <input
            type="number"
            min="0"
            max="1000000"
            step="0.01"
            value={filters.budget}
            onChange={(e) => setFilters({ ...filters, budget: e.target.value })}
          />
        </label>
        <Button type="submit">Применить фильтры</Button>
      </form>
      {feed.isPending && <p role="status">Подбираем мероприятия…</p>}
      {feed.isError && (
        <Alert>
          Подборка временно недоступна.{' '}
          <Button onClick={() => void feed.refetch()}>Повторить</Button>
        </Alert>
      )}
      {feed.data && (
        <>
          {feed.data.mode === 'upcoming' && (
            <p>
              {feed.data.degraded
                ? 'Персональная подборка готовится. Пока показываем ближайшие мероприятия.'
                : 'Выберите интересы или сохраните мероприятия, чтобы настроить подборку.'}
            </p>
          )}
          {!feed.data.items.length && <p>По этим условиям пока нет мероприятий.</p>}
          <RecommendationCards items={feed.data.items} />
        </>
      )}
    </section>
  );
}

function Profile({ actor }: { actor: string }) {
  const { api } = useBuyer();
  const client = useQueryClient();
  const profile = useQuery({
    queryKey: ['recommendation-profile', actor],
    queryFn: async ({ signal }) =>
      recommendationProfileSchema.parse(
        unwrap(await api.client.GET('/api/v1/recommendations/profile', { signal })),
      ),
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      recommendationProfileSchema.parse(
        unwrap(
          await api.client.DELETE('/api/v1/recommendations/favorites/{id}', {
            params: { path: { id } },
          }),
        ),
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['recommendation-profile', actor] });
    },
  });
  if (profile.isPending) return <p role="status">Загружаем настройки…</p>;
  if (profile.isError)
    return (
      <Alert>
        Не удалось загрузить настройки.{' '}
        <Button onClick={() => void profile.refetch()}>Повторить</Button>
      </Alert>
    );
  return (
    <>
      <Interests profile={profile.data} />
      <section className="preference-panel">
        <h2>Избранное</h2>
        {!profile.data.favorites.length && <p>Сохраняйте мероприятия на их странице.</p>}
        <ul className="favorite-list">
          {profile.data.favorites.map(({ eventId, event }) => (
            <li key={eventId}>
              <span>
                {event ? (
                  <a href={'/events/' + eventId}>{event.title}</a>
                ) : (
                  'Мероприятие больше недоступно'
                )}
              </span>
              <Button
                variant="secondary"
                disabled={remove.isPending}
                onClick={() => remove.mutate(eventId)}
                aria-label={'Удалить из избранного: ' + (event?.title ?? 'недоступное мероприятие')}
              >
                Удалить
              </Button>
            </li>
          ))}
        </ul>
        {remove.error && <Alert>Не удалось удалить. Повторите запрос.</Alert>}
      </section>
      <PersonalFeed actor={actor} profile={profile.data} />
    </>
  );
}

function SessionGate() {
  const { session } = useBuyer();
  if (session.isPending) return <p role="status">Проверяем аккаунт…</p>;
  if (session.isError)
    return (
      <Alert>
        Не удалось проверить аккаунт.{' '}
        <Button onClick={() => void session.refetch()}>Повторить</Button>
      </Alert>
    );
  if (!session.data.user)
    return (
      <p>
        <a href="/api/v1/auth/login?returnTo=%2Frecommendations">
          Войдите, чтобы настроить подборку
        </a>
      </p>
    );
  if (!session.data.user.emailVerified)
    return <Alert>Подтвердите email для настройки подборки.</Alert>;
  return <Profile key={session.data.user.sub} actor={session.data.user.sub} />;
}
export function Preferences() {
  return (
    <BookingProvider>
      <SessionGate />
    </BookingProvider>
  );
}
