'use client';

import { useEffect, useState, useRef } from 'react';
import { LucideIcon } from 'lucide-react';

interface AnimatedMeterProps {
  value: number | string;
  label: string;
  icon: LucideIcon;
  suffix?: string;
  animate?: boolean;
}

export function AnimatedMeter({
  value,
  label,
  icon: Icon,
  suffix = '',
  animate = true,
}: AnimatedMeterProps) {
  const [animatedValue, setAnimatedValue] = useState(0);
  const prevValueRef = useRef<number>(0);
  const displayValue = typeof value === 'number' && animate ? animatedValue : value;

  useEffect(() => {
    if (typeof value !== 'number' || !animate) {
      return;
    }

    const startValue = prevValueRef.current;
    const endValue = value;
    const duration = 1000;
    const startTime = Date.now();
    let frame = 0;

    const animateValue = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Ease-out cubic
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const currentValue = Math.round(startValue + (endValue - startValue) * easeOut);

      setAnimatedValue(currentValue);
      // Track what's on screen so an interrupted animation resumes from here
      prevValueRef.current = currentValue;

      if (progress < 1) {
        frame = requestAnimationFrame(animateValue);
      }
    };

    frame = requestAnimationFrame(animateValue);
    return () => cancelAnimationFrame(frame);
  }, [value, animate]);

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 border border-border/50">
      <div className="p-2 rounded-md bg-muted">
        <Icon className="w-5 h-5 text-foreground" />
      </div>
      <div className="flex flex-col">
        <span className="text-xl font-bold text-foreground animate-count-up">
          {displayValue}{suffix}
        </span>
        <span className="text-xs text-muted-foreground uppercase tracking-wider">
          {label}
        </span>
      </div>
    </div>
  );
}
