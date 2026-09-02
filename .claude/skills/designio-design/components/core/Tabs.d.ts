export interface TabsProps {
  items?: string[];
  value?: string;
  onChange?: (item: string) => void;
}
export declare function Tabs(props: TabsProps): JSX.Element;