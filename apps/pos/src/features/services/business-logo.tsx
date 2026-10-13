import type {BusinessHeader,PrintLayout} from '../../platform/management';
// Original thermal-ticket logo. Only the frozen, validated local PNG is used.
export function BusinessLogo({business,layout}:{business:BusinessHeader|null|undefined;layout?:PrintLayout}){
 if(layout?.showLogo===false||!business?.logo?.startsWith('data:image/png;base64,'))return null;
 const es58=layout?.paperWidth==='58mm';
 return <img src={business.logo} alt={business.name} className="mx-auto mb-2" style={{maxWidth:es58?'32mm':'45mm',maxHeight:es58?'16mm':'22mm',objectFit:'contain'}}/>;
}
