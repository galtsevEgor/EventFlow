import { useState } from 'react';
import { Button, Field, Select } from '@eventflow/ui';
import type { VenueMap } from '@eventflow/event-contracts';
type Feature = VenueMap['features'][number];

export function MapDimensions({
  map,
  onChange,
}: {
  map: VenueMap;
  onChange: (map: VenueMap) => void;
}) {
  const [width, setWidth] = useState(map.width),
    [height, setHeight] = useState(map.height);
  return (
    <fieldset className="configuration-section">
      <legend>Размеры плана</legend>
      <div className="grid-tools">
        <Field
          label="Ширина плана"
          type="number"
          min={200}
          max={10000}
          value={width}
          onChange={(e) => setWidth(Number(e.target.value))}
        />
        <Field
          label="Высота плана"
          type="number"
          min={200}
          max={10000}
          value={height}
          onChange={(e) => setHeight(Number(e.target.value))}
        />
        <Button type="button" onClick={() => onChange({ ...map, width, height })}>
          Применить размеры
        </Button>
      </div>
    </fieldset>
  );
}
export function VenueFeatures({
  map,
  onChange,
}: {
  map: VenueMap;
  onChange: (map: VenueMap) => void;
}) {
  const [editing, setEditing] = useState('new');
  const current = map.features.find((f) => f.id === editing);
  return (
    <fieldset className="configuration-section">
      <legend>Сцена, сектора и проходы</legend>
      <div className="grid-tools">
        <Select
          label="Объект плана"
          value={current?.id ?? 'new'}
          onChange={(e) => setEditing(e.target.value)}
        >
          <option value="new">Новый объект</option>
          {map.features.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </Select>
        {current && (
          <Button
            type="button"
            onClick={() => {
              onChange({ ...map, features: map.features.filter((f) => f.id !== current.id) });
              setEditing('new');
            }}
          >
            Удалить объект
          </Button>
        )}
      </div>
      <FeatureFields
        key={JSON.stringify(current) ?? 'new'}
        initial={current}
        onApply={(feature) => {
          onChange({
            ...map,
            features: [...map.features.filter((f) => f.id !== feature.id), feature],
          });
          setEditing(feature.id);
        }}
      />
    </fieldset>
  );
}
function FeatureFields({
  initial,
  onApply,
}: {
  initial: Feature | undefined;
  onApply: (feature: Feature) => void;
}) {
  const [feature, setFeature] = useState<Feature>(
    () =>
      initial ?? {
        id: crypto.randomUUID(),
        kind: 'sector',
        label: 'Сектор',
        x: 20,
        y: 90,
        width: 200,
        height: 100,
      },
  );
  return (
    <>
      <div className="grid-tools">
        <Field
          label="Название объекта"
          maxLength={60}
          value={feature.label}
          onChange={(e) => setFeature({ ...feature, label: e.target.value })}
        />
        <Select
          label="Тип объекта"
          value={feature.kind}
          onChange={(e) => setFeature({ ...feature, kind: e.target.value as Feature['kind'] })}
        >
          <option value="stage">Сцена</option>
          <option value="sector">Сектор</option>
          <option value="aisle">Проход</option>
        </Select>
        {(['x', 'y', 'width', 'height'] as const).map((field, i) => (
          <Field
            key={field}
            label={['X объекта', 'Y объекта', 'Ширина объекта', 'Высота объекта'][i]!}
            type="number"
            min={field === 'width' || field === 'height' ? 20 : 0}
            max={10000}
            value={feature[field]}
            onChange={(e) => setFeature({ ...feature, [field]: Number(e.target.value) })}
          />
        ))}
      </div>
      <Button type="button" onClick={() => onApply(feature)}>
        {initial ? 'Применить объект' : 'Добавить объект'}
      </Button>
    </>
  );
}
