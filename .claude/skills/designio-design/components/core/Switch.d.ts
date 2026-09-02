export interface SwitchProps {
  on?: boolean;
  onToggle?: () => void;
  label?: React.ReactNode;
}
export declare function Switch(props: SwitchProps): JSX.Element;