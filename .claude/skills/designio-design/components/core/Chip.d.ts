export interface ChipProps {
  /** Estado canónico del dominio (I1: no se renombra) */
  estado?: 'hecho' | 'en curso' | 'próximo' | 'candidato' | 'en medición';
  children?: React.ReactNode;
}
export declare function Chip(props: ChipProps): JSX.Element;