import { useId } from 'react';
import { accountIdentity } from '@/lib/account-identity';
import {
  badgeGeometry,
  currencyFromLabel,
  glyphs,
  owners,
  tileFor,
  type BadgeSize,
  type Owner,
} from '@/lib/account-visuals';
import { cn } from '@/lib/utils';

export type AccountBadgeProps = {
  source: string | undefined;
  /** The account's currency; when omitted, the one written in the label is used. */
  currency?: string | null;
  label: string | null | undefined;
  owner?: Owner | null;
  size?: BadgeSize;
  className?: string;
};

/**
 * One SVG that identifies an account: the bank's glyph on the card's tile, the
 * currency in a pill over the bottom-right corner and the household member who
 * holds it in a disc over the top-left. The small size keeps only the tile and
 * shows the member as a ring, so it still reads in a dense row. Every colour
 * is a token from index.css, resolved by the browser.
 */
export function AccountBadge({
  source,
  currency,
  label,
  owner,
  size = 'md',
  className,
}: AccountBadgeProps) {
  const titleId = useId();
  const resolvedCurrency = currency ?? currencyFromLabel(label);
  const identity = accountIdentity(source, resolvedCurrency ?? '', label);
  const tile = tileFor(identity.bank, identity.product);
  const glyph = glyphs[identity.bank ?? 'unknown'];
  const member = owner ? owners[owner] : null;
  const g = badgeGeometry(size, {
    owner: Boolean(member),
    currency: size === 'sm' ? null : resolvedCurrency,
  });
  const description = [
    identity.name,
    resolvedCurrency && !identity.name.includes(resolvedCurrency)
      ? resolvedCurrency
      : '',
    member?.name ?? '',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <svg
      role="img"
      aria-labelledby={titleId}
      viewBox={g.viewBox}
      height={g.height}
      style={{ width: 'auto' }}
      className={cn('shrink-0 overflow-visible', className)}
    >
      <title id={titleId}>{description}</title>
      <rect
        x={g.tile.x}
        y={g.tile.y}
        width={g.tile.size}
        height={g.tile.size}
        rx={g.tile.radius}
        fill={tile.fill}
        stroke={g.ring && member ? member.color : (tile.border ?? 'none')}
        strokeWidth={g.ring ? g.ring.width : tile.border ? 1 : 0}
      />
      <path
        d={glyph.path}
        fill={tile.ink}
        fillRule={glyph.fillRule}
        transform={`translate(${g.glyph.x} ${g.glyph.y}) scale(${g.glyph.scale})`}
      />
      {g.pill && resolvedCurrency ? (
        <g>
          <rect
            x={g.pill.x}
            y={g.pill.y}
            width={g.pill.width}
            height={g.pill.height}
            rx={g.pill.radius}
            fill="var(--card)"
            stroke="var(--border)"
            strokeWidth="1"
          />
          <text
            x={g.pill.x + g.pill.width / 2}
            y={g.pill.y + g.pill.height / 2 + 0.3}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={g.pill.fontSize}
            fontWeight={700}
            letterSpacing={0.4}
            fill="var(--foreground)"
          >
            {resolvedCurrency}
          </text>
        </g>
      ) : null}
      {g.disc && member ? (
        <g>
          <circle
            cx={g.disc.cx}
            cy={g.disc.cy}
            r={g.disc.r}
            fill={member.color}
            stroke="var(--card)"
            strokeWidth="1.5"
          />
          <text
            x={g.disc.cx}
            y={g.disc.cy + 0.3}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={g.disc.fontSize}
            fontWeight={700}
            fill="var(--account-ink)"
          >
            {member.initial}
          </text>
        </g>
      ) : null}
    </svg>
  );
}
