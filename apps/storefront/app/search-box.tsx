'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Schemas } from '@eventflow/api-client';

const SUGGESTIONS_DEBOUNCE_MS = 220;

type Suggestion = Schemas['SearchSuggestions']['suggestions'][number];

export function SearchBox({ initialValue }: { initialValue: string }) {
  const [query, setQuery] = useState(initialValue);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(-1),
    [open, setOpen] = useState(false);
  const dismissed = useRef(true),
    id = useId(),
    router = useRouter();
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    const timer = setTimeout(async () => {
      if (query.trim().length < 2) {
        setSuggestions([]);
        setOpen(false);
        return;
      }
      try {
        const response = await fetch(
          '/api/v1/search/suggest?' + new URLSearchParams({ q: query }),
          {
            signal: controller.signal,
            cache: 'no-store',
          },
        );
        if (!response.ok) throw new Error('Suggestions unavailable');
        const data: Schemas['SearchSuggestions'] = await response.json();
        if (current) {
          setSuggestions(data.suggestions);
          setActive(-1);
          setOpen(!dismissed.current && data.suggestions.length > 0);
        }
      } catch {
        if (current) {
          setSuggestions([]);
          setOpen(false);
        }
      }
    }, SUGGESTIONS_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  const choose = (suggestion: Suggestion) => {
    setOpen(false);
    router.push('/events/' + suggestion.id);
  };
  return (
    <div className="search-box">
      <label htmlFor={id}>Название или описание</label>
      <input
        id={id}
        name="q"
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={id + '-options'}
        aria-activedescendant={open && active >= 0 ? id + '-option-' + active : undefined}
        autoComplete="off"
        maxLength={160}
        placeholder="Что ищем?"
        value={query}
        onChange={(event) => {
          dismissed.current = false;
          setActive(-1);
          setSuggestions([]);
          setOpen(false);
          setQuery(event.target.value);
        }}
        onFocus={() => {
          dismissed.current = false;
          if (suggestions.length) setOpen(true);
        }}
        onBlur={() => {
          dismissed.current = true;
          setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            dismissed.current = true;
            setOpen(false);
            setActive(-1);
          }
          if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setActive(
              (value) =>
                (value + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) %
                suggestions.length,
            );
          }
          if (open && event.key === 'Enter' && active >= 0) {
            event.preventDefault();
            choose(suggestions[active]!);
          }
        }}
      />
      {open && (
        <ul
          id={id + '-options'}
          role="listbox"
          aria-label="Подсказки мероприятий"
          className="search-suggestions"
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.id}
              id={id + '-option-' + index}
              role="option"
              aria-selected={active === index}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(suggestion)}
            >
              <span>{suggestion.title}</span>
              <small>{suggestion.city}</small>
            </li>
          ))}
        </ul>
      )}
      <span className="sr-only" aria-live="polite">
        {open ? 'Подсказок: ' + suggestions.length : ''}
      </span>
    </div>
  );
}
