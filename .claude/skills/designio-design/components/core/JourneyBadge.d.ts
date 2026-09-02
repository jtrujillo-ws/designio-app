export interface JourneyBadgeProps {
  /** Journey 1–7; toma su hue del arco */
  j?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  soft?: boolean;
}
export declare function JourneyBadge(props: JourneyBadgeProps): JSX.Element;