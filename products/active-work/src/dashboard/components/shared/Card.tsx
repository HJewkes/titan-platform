/**
 * Generic bordered panel, ported from brain's dashboard shared components
 * (`packages` sibling repo) and adapted to active-work's own tokens.
 */
import React from 'react';
import { View } from 'react-native';
import { palette, radii } from '../../tokens.js';

interface CardProps {
  children: React.ReactNode;
  variant?: 'plain' | 'accent' | 'subtle';
  accentColor?: string;
  accentWidth?: number;
  borderColor?: string;
  bg?: string;
  padding?: number;
  radius?: number;
}

export function Card({
  children,
  variant = 'plain',
  accentColor,
  accentWidth = 3,
  borderColor,
  bg,
  padding = 10,
  radius = radii.md,
}: CardProps): React.JSX.Element {
  const baseStyle = {
    borderRadius: radius,
    padding,
    borderWidth: 1,
    borderColor: borderColor ?? palette.border,
  };
  const accent = accentColor ?? palette.brand;

  return (
    <View
      style={{
        ...baseStyle,
        ...variantStyle(variant, { accent, accentWidth, borderColor, bg }),
      }}
    >
      {children}
    </View>
  );
}

interface VariantOptions {
  accent: string;
  accentWidth: number;
  borderColor?: string;
  bg?: string;
}

function variantStyle(
  variant: NonNullable<CardProps['variant']>,
  { accent, accentWidth, borderColor, bg }: VariantOptions,
) {
  if (variant === 'accent') {
    return {
      backgroundColor: bg ?? palette.surface2,
      borderLeftWidth: accentWidth,
      borderLeftColor: accent,
    };
  }
  if (variant === 'subtle') {
    return {
      backgroundColor: bg ?? palette.surface1,
      borderColor: borderColor ?? `${accent}40`,
    };
  }
  return { backgroundColor: bg ?? palette.surface2 };
}
