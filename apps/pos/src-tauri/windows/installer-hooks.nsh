; Tauri's interactive downgrade flag alone does not protect silent installs.
; Check before copying files in every mode. Data directories are never touched.
!macro VENTARD_REFUSE_DOWNGRADE
  IfSilent +2 0
    MessageBox MB_OK|MB_ICONSTOP "Ya tienes una versión más reciente de VentaRD. Conserva esa versión para proteger tus datos."
  SetErrorLevel 2
  Abort
!macroend

!macro NSIS_HOOK_PREINSTALL
  Push $R8
  Push $R9
  ReadRegStr $R8 HKCU "${UNINSTKEY}" "DisplayVersion"
  ${If} $R8 != ""
    nsis_tauri_utils::SemverCompare "${VERSION}" "$R8"
    Pop $R9
    ${If} $R9 == -1
      !insertmacro VENTARD_REFUSE_DOWNGRADE
    ${EndIf}
  ${EndIf}
  ClearErrors
  ${GetFileVersion} "$INSTDIR\${MAINBINARYNAME}.exe" $R8
  ${IfNot} ${Errors}
    ${VersionCompare} "${VERSIONWITHBUILD}" "$R8" $R9
    ${If} $R9 == 2
      !insertmacro VENTARD_REFUSE_DOWNGRADE
    ${EndIf}
  ${EndIf}
  Pop $R9
  Pop $R8
!macroend
