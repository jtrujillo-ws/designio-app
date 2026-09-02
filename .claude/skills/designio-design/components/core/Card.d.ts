export interface CardProps {
  /** Journey 1–7: pinta el border-top con su hue del arco */
  j?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** Elemento activo del loop: borde gradiente + shadow-arco */
  active?: boolean;
  /** Futuro/pendiente: dashed y atenuado */
  pending?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function Card(props: CardProps): JSX.Element;